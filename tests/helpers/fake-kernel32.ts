// A simulated Windows serial driver behind the Kernel32Api surface, so the
// Win32Port state machine — overlapped I/O, chunked writes, cancellation,
// close — runs on any OS. It models what the port relies on:
// - a read completes at once with whatever is buffered; with nothing buffered
//   it pends until bytes arrive (receive()) or the read wait passes, then
//   completes empty — unless `ignoresReadWait`, a driver that always returns
//   at once
// - writes pend for `writeLatencyMs` each and complete in order, one at a time
// - `stalled` holds every write (CTS held low) until released
// - CancelIoEx completes pending reads and writes as STATUS_CANCELLED
// - ClearCommError reports pending write bytes (plus `extraOutQueue`) as cbOutQue
// - every completion signals the operation's event, and watch() hears of it
//   a moment later, the way the thread pool's callback arrives

import type { Pointer } from 'bun:ffi'
import { canceledError } from '../../src/errors.js'
import {
  COMSTAT,
  DCB,
  ERROR_IO_INCOMPLETE,
  ERROR_IO_PENDING,
  ERROR_OPERATION_ABORTED,
  OVERLAPPED,
  STATUS_PENDING,
} from '../../src/bindings/win32/constants.js'
import type { Kernel32Api } from '../../src/bindings/win32/ffi.js'
import type { Win32Api } from '../../src/bindings/win32/port.js'
import { fromWide } from '../../src/bindings/win32/structs.js'
import type { HandleWatch, ThreadCall } from '../../src/bindings/win32/waits.js'

const STATUS_SUCCESS = 0
const STATUS_CANCELLED = 0xc0000120
const STATUS_UNSUCCESSFUL = 0xc0000001
export const PORT_HANDLE = 0x1000 as Pointer

interface PendingWrite {
  overlapped: Uint8Array
  data: Uint8Array
}

interface PendingRead {
  overlapped: Uint8Array
  buffer: Uint8Array
  timer: ReturnType<typeof setTimeout>
}

interface FakeEvent {
  signaled: boolean
  waiters: Set<() => void>
}

export class FakeComm implements Kernel32Api {
  /** Port names that exist. */
  readonly ports = new Set(['COM3'])
  /** Ports another program holds. */
  readonly busy = new Set<string>()
  /** Devices that open but aren't serial ports. */
  readonly notSerial = new Set<string>()

  /** Each completed write, in completion order. */
  readonly written: Uint8Array[] = []
  writeLatencyMs = 1
  /** Driver bytes not yet transmitted, beyond pending writes. */
  extraOutQueue = 0
  /** Reads complete at once even with nothing to return. */
  ignoresReadWait = false
  /** How long an empty read waits; by default what SetCommTimeouts asked for. */
  readWaitMs: number | null = null
  /** FlushFileBuffers fails. */
  flushFails = false
  modemStatus = 0
  maxPendingWrites = 0
  /** ReadFile calls made, to tell waiting from polling. */
  readCalls = 0
  /** ClearCommError calls made. */
  queueChecks = 0
  /** Every state-changing call, e.g. "PurgeComm:12" or "EscapeCommFunction:4". */
  readonly calls: string[] = []
  dcb = new Uint8Array(DCB.size)
  timeouts: Uint8Array | null = null
  readonly closedHandles = new Set<number>()
  /** Events closed while something still watched them: always a bug. */
  readonly closedWhileWatched: number[] = []

  #inbound: number[] = []
  #readError = 0
  #stalled = false
  #lastError = 0
  #nextHandle = 0x2000
  #device = ''
  #pending: PendingWrite[] = []
  #pendingRead: PendingRead | null = null
  #failures = new Map<Uint8Array, number>()
  #events = new Map<number, FakeEvent>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #flushWaiters: (() => void)[] = []

  /** The Win32Api to hand Win32Port.open() or createWin32Binding(). */
  api(): Win32Api {
    return {
      kernel32: this,
      watch: (event) => this.#watch(event),
      flush: () => this.#flush(),
      closeHandle: async (handle) => void this.CloseHandle(handle),
    }
  }

  get stalled(): boolean {
    return this.#stalled
  }

  set stalled(value: boolean) {
    this.#stalled = value
    if (value) {
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = null
    } else {
      this.#schedule()
      if (this.#queued() === 0) for (const wake of this.#flushWaiters.splice(0)) wake()
    }
  }

  /** When nonzero, ReadFile fails with this Win32 error — a pending read too. */
  get readError(): number {
    return this.#readError
  }

  set readError(error: number) {
    this.#readError = error
    const read = this.#pendingRead
    if (error && read) {
      this.#pendingRead = null
      clearTimeout(read.timer)
      this.#failures.set(read.overlapped, error)
      this.#complete(read.overlapped, STATUS_UNSUCCESSFUL, 0)
    }
  }

  /** The device sends `bytes`. */
  receive(bytes: Iterable<number>): void {
    this.#inbound.push(...bytes)
    const read = this.#pendingRead
    if (read && this.#inbound.length > 0) {
      this.#pendingRead = null
      clearTimeout(read.timer)
      this.#completeRead(read.overlapped, read.buffer)
    }
  }

  /** Watches still registered. */
  get activeWatches(): number {
    let count = 0
    for (const event of this.#events.values()) count += event.waiters.size
    return count
  }

  /** Everything written, in order. */
  writtenBytes(): Uint8Array {
    return Uint8Array.from(this.written.flatMap((chunk) => [...chunk]))
  }

  // --- Kernel32Api ---

  CreateFileW(name: Uint8Array): Pointer | bigint | null {
    const device = fromWide(name).replace(/^\\\\\.\\/, '')
    if (this.busy.has(device)) return this.#fail(5, -1n) // ERROR_ACCESS_DENIED
    if (!this.ports.has(device) && !this.notSerial.has(device)) return this.#fail(2, -1n) // ERROR_FILE_NOT_FOUND
    this.#device = device
    this.calls.push(`CreateFileW:${device}`)
    return PORT_HANDLE
  }

  CloseHandle(handle: Pointer): number {
    this.closedHandles.add(handle)
    const event = this.#events.get(handle)
    if (event?.waiters.size) this.closedWhileWatched.push(handle)
    this.#events.delete(handle)
    return 1
  }

  GetLastError(): number {
    return this.#lastError
  }

  GetCommState(_handle: Pointer, dcb: Uint8Array): number {
    if (this.notSerial.has(this.#device)) return this.#fail(1, 0) // ERROR_INVALID_FUNCTION
    dcb.set(this.dcb)
    return 1
  }

  SetCommState(_handle: Pointer, dcb: Uint8Array): number {
    this.dcb = dcb.slice()
    this.calls.push('SetCommState')
    return 1
  }

  SetCommTimeouts(_handle: Pointer, timeouts: Uint8Array): number {
    this.timeouts = timeouts.slice()
    return 1
  }

  SetupComm(): number {
    return 1
  }

  ReadFile(_handle: Pointer, buffer: Uint8Array, length: number, _transferred: null, overlapped: Uint8Array): number {
    this.readCalls++
    if (this.#readError) return this.#fail(this.#readError, 0)
    this.#reset(overlapped)
    const target = buffer.subarray(0, length)
    if (this.#inbound.length > 0 || this.ignoresReadWait) {
      this.#completeRead(overlapped, target)
      return 1
    }
    setStatus(overlapped, STATUS_PENDING, 0)
    const timer = setTimeout(() => {
      if (this.#pendingRead?.overlapped !== overlapped) return
      this.#pendingRead = null
      this.#complete(overlapped, STATUS_SUCCESS, 0)
    }, this.readWaitMs ?? this.#timeoutConstant())
    this.#pendingRead = { overlapped, buffer: target, timer }
    return this.#fail(ERROR_IO_PENDING, 0)
  }

  WriteFile(_handle: Pointer, buffer: Uint8Array, length: number, _transferred: null, overlapped: Uint8Array): number {
    this.#reset(overlapped)
    setStatus(overlapped, STATUS_PENDING, 0)
    this.#pending.push({ overlapped, data: buffer.slice(0, length) })
    this.maxPendingWrites = Math.max(this.maxPendingWrites, this.#pending.length)
    this.#schedule()
    return this.#fail(ERROR_IO_PENDING, 0)
  }

  GetOverlappedResult(_handle: Pointer, overlapped: Uint8Array, transferred: Uint32Array): number {
    const view = new DataView(overlapped.buffer, overlapped.byteOffset, overlapped.byteLength)
    const status = view.getUint32(0, true)
    if (status === STATUS_PENDING) return this.#fail(ERROR_IO_INCOMPLETE, 0)
    if (status === STATUS_CANCELLED) return this.#fail(ERROR_OPERATION_ABORTED, 0)
    if (status === STATUS_UNSUCCESSFUL) return this.#fail(this.#failures.get(overlapped) ?? 31, 0)
    transferred[0] = Number(view.getBigUint64(8, true))
    return 1
  }

  CancelIoEx(_handle: Pointer, overlapped: Uint8Array | null): number {
    this.calls.push(overlapped ? 'CancelIoEx' : 'CancelIoEx:all')
    const read = this.#pendingRead
    if (read && (overlapped === null || overlapped === read.overlapped)) {
      this.#pendingRead = null
      clearTimeout(read.timer)
      this.#complete(read.overlapped, STATUS_CANCELLED, 0)
    }
    const canceled = this.#pending.filter((write) => overlapped === null || write.overlapped === overlapped)
    const wasHead = canceled.includes(this.#pending[0]!)
    this.#pending = this.#pending.filter((write) => !canceled.includes(write))
    for (const write of canceled) this.#complete(write.overlapped, STATUS_CANCELLED, 0)
    if (wasHead && this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
      this.#schedule()
    }
    return 1
  }

  CreateEventW(): Pointer | bigint | null {
    const handle = this.#nextHandle++
    this.#events.set(handle, { signaled: false, waiters: new Set() })
    return handle as Pointer
  }

  EscapeCommFunction(_handle: Pointer, fn: number): number {
    this.calls.push(`EscapeCommFunction:${fn}`)
    return 1
  }

  GetCommModemStatus(_handle: Pointer, status: Uint32Array): number {
    status[0] = this.modemStatus
    return 1
  }

  PurgeComm(_handle: Pointer, flags: number): number {
    this.calls.push(`PurgeComm:${flags}`)
    if (flags & 0x4) this.extraOutQueue = 0 // PURGE_TXCLEAR
    return 1
  }

  ClearCommError(_handle: Pointer, errors: Uint32Array, status: Uint8Array): number {
    this.queueChecks++
    errors[0] = 0
    new DataView(status.buffer, status.byteOffset, status.byteLength).setUint32(COMSTAT.cbOutQue, this.#queued(), true)
    return 1
  }

  // --- simulation ---

  #timeoutConstant(): number {
    return this.timeouts ? new DataView(this.timeouts.buffer).getUint32(8, true) : 1000
  }

  #queued(): number {
    return this.extraOutQueue + this.#pending.reduce((total, write) => total + write.data.length, 0)
  }

  #completeRead(overlapped: Uint8Array, buffer: Uint8Array): void {
    const count = Math.min(buffer.length, this.#inbound.length)
    buffer.set(this.#inbound.splice(0, count))
    this.#complete(overlapped, STATUS_SUCCESS, count)
  }

  // Complete pending writes one after another, `writeLatencyMs` apart.
  #schedule(): void {
    if (this.#timer || this.#stalled || this.#pending.length === 0) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      const head = this.#pending.shift()
      if (head) {
        this.written.push(head.data)
        this.#complete(head.overlapped, STATUS_SUCCESS, head.data.length)
      }
      this.#schedule()
    }, this.writeLatencyMs)
  }

  // Fill in the status block, then signal the event, as the kernel does.
  #complete(overlapped: Uint8Array, status: number, count: number): void {
    setStatus(overlapped, status, count)
    const event = this.#events.get(eventOf(overlapped))
    if (!event) return
    event.signaled = true
    for (const wake of event.waiters) setTimeout(wake, 0)
  }

  // ReadFile and WriteFile reset the event as they start.
  #reset(overlapped: Uint8Array): void {
    const event = this.#events.get(eventOf(overlapped))
    if (event) event.signaled = false
  }

  #watch(handle: Pointer): HandleWatch {
    let resolve!: () => void
    const done = new Promise<void>((settle) => (resolve = settle))
    const event = this.#events.get(handle)
    if (!event) throw new Error(`watch() of a handle that isn't an open event: ${handle}`)
    let watching = true
    const finish = () => {
      if (!watching) return
      watching = false
      event.waiters.delete(finish)
      resolve()
    }
    event.waiters.add(finish)
    if (event.signaled) setTimeout(finish, 0)
    return { done, stop: finish }
  }

  // FlushFileBuffers: done once nothing is queued, held while stalled.
  #flush(): ThreadCall {
    let reject!: (error: unknown) => void
    const result = new Promise<boolean>((resolve, rejectResult) => {
      reject = rejectResult
      this.calls.push('FlushFileBuffers')
      if (!this.#stalled) resolve(!this.flushFails)
      else this.#flushWaiters.push(() => resolve(!this.flushFails))
    })
    return { result, abandon: () => reject(canceledError()) }
  }

  #fail<T>(error: number, value: T): T {
    this.#lastError = error
    return value
  }
}

function setStatus(overlapped: Uint8Array, status: number, count: number): void {
  const view = new DataView(overlapped.buffer, overlapped.byteOffset, overlapped.byteLength)
  view.setUint32(0, status, true)
  view.setBigUint64(8, BigInt(count), true)
}

function eventOf(overlapped: Uint8Array): number {
  const view = new DataView(overlapped.buffer, overlapped.byteOffset, overlapped.byteLength)
  return Number(view.getBigUint64(OVERLAPPED.hEvent, true))
}
