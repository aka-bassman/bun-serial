// One open COM port. The handle is opened for overlapped I/O, so ReadFile and
// WriteFile return at once and complete in the background. Nothing polls for
// the completion: the system thread pool waits on each operation's event and
// tells this thread (waits.ts), so a port waiting for data costs no CPU, and
// data is delivered within a fraction of a millisecond of the driver having it.
//
// Reads wait in the driver: with ReadIntervalTimeout and
// ReadTotalTimeoutMultiplier at MAXDWORD, ReadFile returns at once with
// whatever is buffered, and otherwise completes as soon as the next byte
// arrives. Writes have no timeouts; they go out in chunks of about
// WRITE_CHUNK_MS of line time, two queued in the driver at once, so progress
// is visible chunk by chunk and the line never idles while a completion is
// being delivered.

import { canceledError, notOpenError, SerialPortError } from '../../errors.js'
import { PortLifetime } from '../../internal/lifetime.js'
import { bytesInMs, transmitBudgetMs } from '../../internal/timing.js'
import type { ResolvedOpenOptions } from '../../options.js'
import type { BindingPort, ModemLines, ModemStatus, UpdateOptions } from '../types.js'
import {
  CLRBREAK,
  CLRDTR,
  CLRRTS,
  COMSTAT,
  DCB,
  ERROR_INVALID_FUNCTION,
  ERROR_INVALID_PARAMETER,
  ERROR_IO_PENDING,
  ERROR_NOT_SUPPORTED,
  FILE_FLAG_OVERLAPPED,
  GENERIC_READ_WRITE,
  MAXDWORD,
  MS_CTS_ON,
  MS_DSR_ON,
  MS_RING_ON,
  MS_RLSD_ON,
  OPEN_EXISTING,
  OVERLAPPED,
  PURGE_RXCLEAR,
  PURGE_TXCLEAR,
  SETBREAK,
  SETDTR,
  SETRTS,
  STATUS_PENDING,
} from './constants.js'
import { kernel32, openErrorCode, validHandle, win32Error, type Handle, type Kernel32 } from './ffi.js'
import {
  checkLineSettings,
  commTimeouts,
  configureDcb,
  devicePath,
  initialLines,
  setLineControl,
  wide,
  type LineLevels,
} from './structs.js'
import { callOnThread, closeOnThread, watchHandle, type HandleWatch, type ThreadCall } from './waits.js'

const READ_BUFFER_SIZE = 65536
// How long a read waits in the driver for a first byte before completing
// empty, to be issued again.
const READ_WAIT_MS = 1000
const DRIVER_QUEUE_SIZE = 65536
const WRITE_CHUNK_MS = 200
const WRITE_CHUNK_MIN = 64
const WRITE_CHUNK_MAX = 65536
// When the output queue can't be measured, and as headroom for the device's own FIFO.
const UNMEASURED_OUTPUT_BYTES = 4096
// drain() looks at the driver's output queue every pollInterval ms at first,
// then less and less often, down to once every this many.
const DRAIN_CHECK_MAX_MS = 10
const CANCEL_GRACE_MS = 1000

/** What a port needs from the OS. Tests pass a simulated driver instead. */
export interface Win32Api {
  readonly kernel32: Kernel32
  /** Learn, without polling, that an operation's event has been signaled. */
  watch(event: Handle): HandleWatch
  /** FlushFileBuffers(handle), off the event loop. */
  flush(handle: Handle): ThreadCall
  /** CloseHandle(handle), off the event loop: some drivers take 100 ms and more. Never rejects. */
  closeHandle(handle: Handle): Promise<void>
}

export function systemApi(): Win32Api {
  return {
    kernel32: kernel32(),
    watch: watchHandle,
    flush: (handle) => callOnThread('FlushFileBuffers', handle),
    closeHandle: closeOnThread,
  }
}

// I/O the kernel never completed, even after CancelIoEx and CloseHandle. Its
// OVERLAPPED and buffer stay referenced here forever: freeing memory the
// kernel may still write into would corrupt the heap.
const abandoned = new Set<Overlapped>()

// An OVERLAPPED struct plus the buffer of the I/O using it. Both must stay
// alive until the kernel is done with them, so the port keeps them here.
class Overlapped {
  readonly bytes = new Uint8Array(OVERLAPPED.size)
  readonly #view = new DataView(this.bytes.buffer)
  buffer: Uint8Array | null = null
  #watch: HandleWatch | null = null

  constructor(readonly event: Handle) {
    this.#view.setBigUint64(OVERLAPPED.hEvent, BigInt(event), true)
  }

  // What HasOverlappedIoCompleted reads: the status word the kernel fills in.
  get pending(): boolean {
    return this.buffer !== null && this.#view.getUint32(OVERLAPPED.Internal, true) === STATUS_PENDING
  }

  begin(buffer: Uint8Array): void {
    this.unwatch()
    this.bytes.fill(0, 0, OVERLAPPED.hEvent) // everything but hEvent
    this.buffer = buffer
  }

  /**
   * Settles once the operation may have completed: its event was signaled,
   * or watching stopped. Callers check `pending` again.
   */
  completion(api: Win32Api): Promise<void> {
    if (!this.pending) return Promise.resolve()
    let watch = this.#watch
    if (!watch) {
      const fresh = api.watch(this.event)
      watch = this.#watch = fresh
      void fresh.done.then(() => {
        if (this.#watch === fresh) this.#watch = null
      })
    }
    return watch.done
  }

  /** Stop watching the event, so it can be reused or closed. */
  unwatch(): void {
    this.#watch?.stop()
    this.#watch = null
  }
}

export class Win32Port implements BindingPort {
  readonly #k: Kernel32
  readonly #api: Win32Api
  readonly #handle: Handle
  readonly #lifetime = new PortLifetime()
  readonly #readBuffer = new Uint8Array(READ_BUFFER_SIZE)
  #readOp: Overlapped
  readonly #writeOps: [Overlapped, Overlapped]
  #options: ResolvedOpenOptions
  // Levels last applied to DTR and RTS, carried into every later SetCommState.
  readonly #lines: LineLevels
  #flushCall: ThreadCall | null = null
  #gone: SerialPortError | null = null

  static open(path: string, options: ResolvedOpenOptions, api: Win32Api = systemApi()): Win32Port {
    checkLineSettings(options)
    const k = api.kernel32
    const handle = k.CreateFileW(wide(devicePath(path)), GENERIC_READ_WRITE, 0, null, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, null)
    if (!validHandle(handle)) {
      const error = k.GetLastError()
      const code = openErrorCode(error)
      if (code === 'BUSY') {
        throw new SerialPortError('BUSY', `${path} is in use by another program`, { syscall: 'CreateFileW', osCode: error })
      }
      throw win32Error('CreateFileW', error, { path, code })
    }
    const events: Handle[] = []
    try {
      configure(k, handle, path, options)
      // One event per OVERLAPPED: the read, and the two write slots.
      for (let i = 0; i < 3; i++) events.push(createEvent(k))
    } catch (err) {
      for (const event of events) k.CloseHandle(event)
      k.CloseHandle(handle)
      throw err
    }
    return new Win32Port(path, options, api, handle, events as [Handle, Handle, Handle])
  }

  private constructor(
    readonly path: string,
    options: ResolvedOpenOptions,
    api: Win32Api,
    handle: Handle,
    [readEvent, writeEventA, writeEventB]: [Handle, Handle, Handle],
  ) {
    this.#options = options
    this.#lines = initialLines(options)
    this.#api = api
    this.#k = api.kernel32
    this.#handle = handle
    this.#readOp = new Overlapped(readEvent)
    this.#writeOps = [new Overlapped(writeEventA), new Overlapped(writeEventB)]
  }

  get options(): ResolvedOpenOptions {
    return this.#options
  }

  get isOpen(): boolean {
    return !this.#lifetime.closed
  }

  async read(buffer: Uint8Array, signal?: AbortSignal): Promise<number> {
    this.#assertUsable()
    for (;;) {
      const op = this.#readOp
      const length = Math.min(buffer.length, this.#readBuffer.length)
      this.#start('ReadFile', op, this.#readBuffer.subarray(0, length))
      while (op.pending) {
        try {
          await this.#lifetime.wait(Infinity, signal, op.completion(this.#api))
        } catch (err) {
          // Given up on: cancel the read, but keep bytes that beat the cancel.
          const count = await this.#cancelRead(op)
          if (count > 0) return this.#deliver(buffer, count)
          throw err
        }
        // close() cancels and settles pending I/O itself; just stop here.
        if (this.#lifetime.closed) throw canceledError()
      }
      const count = this.#finish('ReadFile', op)
      if (count > 0) return this.#deliver(buffer, count)
      // Nothing for READ_WAIT_MS — or a driver that ignores the wait and
      // returns at once, which this pause turns into plain polling.
      await this.#lifetime.wait(this.#options.pollInterval, signal)
      this.#assertUsable(true)
    }
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.#assertUsable()
    const chunkSize = Math.min(WRITE_CHUNK_MAX, Math.max(WRITE_CHUNK_MIN, bytesInMs(this.#options, WRITE_CHUNK_MS)))
    const inFlight: Overlapped[] = []
    let issued = 0
    // When the oldest chunk in flight became the oldest: its transmission
    // can't have started before then.
    let headSince = performance.now()
    try {
      for (;;) {
        // Keep two chunks queued so the line doesn't idle while we notice a completion.
        while (inFlight.length < this.#writeOps.length && issued < data.length) {
          const op = this.#writeOps.find((slot) => !inFlight.includes(slot)) as Overlapped
          const chunk = data.subarray(issued, issued + chunkSize)
          this.#start('WriteFile', op, chunk)
          inFlight.push(op)
          issued += chunk.length
        }
        const head = inFlight[0]
        if (!head) return

        if (!head.pending) {
          const expected = head.buffer?.length ?? 0
          const written = this.#finish('WriteFile', head)
          inFlight.shift()
          // Without write timeouts a write completes in full; anything less
          // would let the next chunk, already queued, jump the gap.
          if (written !== expected) {
            throw new SerialPortError('IO', `WriteFile ${this.path} wrote ${written} of ${expected} bytes`, {
              syscall: 'WriteFile',
            })
          }
          headSince = performance.now()
          continue
        }

        // Progress isn't visible inside a chunk, so it counts as stalled once
        // it has outlasted its own transmission time: from then on `signal`
        // may end it, and writeTimeout later on does.
        const pendingMs = performance.now() - headSince
        const transmitMs = transmitBudgetMs(this.#options, head.buffer?.length ?? 0)
        const stalled = pendingMs >= transmitMs
        const deadline = stalled ? transmitMs + this.#options.writeTimeout : transmitMs
        if (stalled) {
          if (signal?.aborted) throw canceledError()
          if (pendingMs >= deadline) {
            throw new SerialPortError('TIMEOUT', `${this.path} accepted no data for ${this.#options.writeTimeout} ms`, {
              syscall: 'WriteFile',
            })
          }
        }
        await this.#lifetime.wait(deadline - pendingMs, stalled ? signal : undefined, head.completion(this.#api))
        if (this.#lifetime.closed) {
          inFlight.length = 0 // close() cancels and settles them
          throw canceledError()
        }
      }
    } finally {
      if (inFlight.length > 0 && !this.#lifetime.closed) await this.#cancel(inFlight)
    }
  }

  async drain(signal?: AbortSignal): Promise<void> {
    this.#assertUsable()
    // Wait for the driver's queue to empty. Its length is all there is to go
    // by, so this does poll: often at first, then less and less.
    let deadline: number | null = null
    let interval = this.#options.pollInterval
    for (;;) {
      const queued = this.#queuedOutput()
      if (queued === 0) break
      if (signal?.aborted) {
        deadline ??= performance.now() + transmitBudgetMs(this.#options, queued + UNMEASURED_OUTPUT_BYTES)
        if (performance.now() >= deadline) {
          this.#k.PurgeComm(this.#handle, PURGE_TXCLEAR)
          throw canceledError()
        }
      }
      await this.#lifetime.wait(interval)
      this.#assertUsable(true)
      interval = Math.max(this.#options.pollInterval, Math.min(DRAIN_CHECK_MAX_MS, interval * 2))
    }

    // Then let FlushFileBuffers, on a thread of its own, wait out whatever
    // write the driver has yet to complete. Giving up discards the rest,
    // which also ends the flush.
    const call = this.#api.flush(this.#handle)
    this.#flushCall = call
    let timer: ReturnType<typeof setTimeout> | undefined
    const giveUp = () => {
      timer = setTimeout(() => {
        if (!this.#lifetime.closed) this.#k.PurgeComm(this.#handle, PURGE_TXCLEAR)
        call.abandon()
      }, transmitBudgetMs(this.#options, UNMEASURED_OUTPUT_BYTES))
    }
    if (signal?.aborted) giveUp()
    else signal?.addEventListener('abort', giveUp, { once: true })
    let flushed: boolean
    try {
      flushed = await call.result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', giveUp)
      if (this.#flushCall === call) this.#flushCall = null
    }
    this.#assertUsable(true)
    if (!flushed) {
      // A thread's exit code says only that the call failed. The device
      // having gone is the likely reason, and ClearCommError says so if it is.
      this.#queuedOutput()
      throw new SerialPortError('IO', `FlushFileBuffers ${this.path} failed`, { syscall: 'FlushFileBuffers' })
    }
  }

  async update(options: UpdateOptions): Promise<void> {
    this.#assertUsable()
    const dcb = new Uint8Array(DCB.size)
    const view = new DataView(dcb.buffer)
    view.setUint32(DCB.DCBlength, DCB.size, true)
    if (!this.#k.GetCommState(this.#handle, dcb)) throw this.#failed('GetCommState')
    view.setUint32(DCB.BaudRate, options.baudRate, true)
    setLineControl(dcb, this.#lines, this.#options.rtscts)
    if (!this.#k.SetCommState(this.#handle, dcb)) {
      const error = this.#k.GetLastError()
      if (error === ERROR_INVALID_PARAMETER) {
        throw new SerialPortError('UNSUPPORTED', `${this.path} does not support ${options.baudRate} baud`, {
          syscall: 'SetCommState',
          osCode: error,
        })
      }
      throw win32Error('SetCommState', error, { path: this.path })
    }
    this.#options = Object.freeze({ ...this.#options, baudRate: options.baudRate })
  }

  async set(lines: ModemLines): Promise<void> {
    this.#assertUsable()
    if (lines.rts !== undefined && this.#options.rtscts) {
      throw new SerialPortError('UNSUPPORTED', 'RTS is driven by hardware flow control (rtscts) on this port')
    }
    // One line at a time: raise before lowering, DTR first among raises and
    // last among lowers. No step then passes through DTR down with RTS up —
    // the state that holds an ESP32/ESP8266 auto-reset circuit in reset —
    // unless that is the state asked for.
    if (lines.dtr === true) this.#setLine('dtr', true)
    if (lines.rts === true) this.#setLine('rts', true)
    if (lines.rts === false) this.#setLine('rts', false)
    if (lines.dtr === false) this.#setLine('dtr', false)
    if (lines.brk !== undefined) this.#escape(lines.brk ? SETBREAK : CLRBREAK)
  }

  async get(): Promise<ModemStatus> {
    this.#assertUsable()
    const status = new Uint32Array(1)
    if (!this.#k.GetCommModemStatus(this.#handle, status)) throw this.#failed('GetCommModemStatus')
    const bits = status[0] ?? 0
    return {
      cts: (bits & MS_CTS_ON) !== 0,
      dsr: (bits & MS_DSR_ON) !== 0,
      dcd: (bits & MS_RLSD_ON) !== 0,
      ri: (bits & MS_RING_ON) !== 0,
    }
  }

  async flush(): Promise<void> {
    this.#assertUsable()
    if (!this.#k.PurgeComm(this.#handle, PURGE_RXCLEAR | PURGE_TXCLEAR)) throw this.#failed('PurgeComm')
  }

  async close(): Promise<void> {
    if (this.#lifetime.closed) return
    this.#lifetime.end()
    this.#flushCall?.abandon()
    this.#flushCall = null
    const k = this.#k
    if (this.#options.hupcl && !this.#gone) {
      // Match HUPCL on POSIX, best effort. RTS goes first: lowering DTR while
      // RTS is still up is the state that resets ESP32/ESP8266 boards.
      if (!this.#options.rtscts) k.EscapeCommFunction(this.#handle, CLRRTS)
      k.EscapeCommFunction(this.#handle, CLRDTR)
    }
    // Cancel whatever is in flight — this port's reads and writes, and a
    // FlushFileBuffers on its thread — and wait for the kernel to let go.
    const ops = [this.#readOp, ...this.#writeOps]
    k.CancelIoEx(this.#handle, null)
    await settle(ops, this.#api)
    await this.#api.closeHandle(this.#handle)
    for (const op of ops) {
      // The kernel signals an abandoned operation's event when it finally
      // completes, so that handle has to outlive it too.
      if (abandoned.has(op)) continue
      op.unwatch()
      k.CloseHandle(op.event)
      op.buffer = null
    }
  }

  // Issue an overlapped ReadFile/WriteFile into `buffer`.
  #start(syscall: 'ReadFile' | 'WriteFile', op: Overlapped, buffer: Uint8Array): void {
    const k = this.#k
    op.begin(buffer)
    const ok =
      syscall === 'ReadFile'
        ? k.ReadFile(this.#handle, buffer, buffer.length, null, op.bytes)
        : k.WriteFile(this.#handle, buffer, buffer.length, null, op.bytes)
    if (ok) return
    const error = k.GetLastError()
    if (error === ERROR_IO_PENDING) return
    op.buffer = null
    throw this.#ioFailure(syscall, error)
  }

  // Collect a completed operation's result: the bytes it transferred.
  #finish(syscall: 'ReadFile' | 'WriteFile', op: Overlapped): number {
    const transferred = new Uint32Array(1)
    const ok = this.#k.GetOverlappedResult(this.#handle, op.bytes, transferred, 0)
    const error = ok ? 0 : this.#k.GetLastError()
    op.buffer = null
    if (!ok) throw this.#ioFailure(syscall, error)
    return transferred[0] ?? 0
  }

  #deliver(buffer: Uint8Array, count: number): number {
    buffer.set(this.#readBuffer.subarray(0, count))
    return count
  }

  // Cancel operations this port gave up on and wait until the kernel lets go.
  async #cancel(ops: Overlapped[]): Promise<void> {
    for (const op of ops) {
      if (op.pending) this.#k.CancelIoEx(this.#handle, op.bytes)
    }
    await settle(ops, this.#api)
    if (this.#lifetime.closed) return // close() took over meanwhile
    for (const op of ops) {
      if (abandoned.has(op)) this.#replace(op)
      else op.buffer = null
    }
  }

  // Cancel a read nobody waits for any more. Resolves with the bytes it
  // got before the cancel took effect, if any.
  async #cancelRead(op: Overlapped): Promise<number> {
    if (op.pending) this.#k.CancelIoEx(this.#handle, op.bytes)
    await settle([op], this.#api)
    if (this.#lifetime.closed) return 0 // close() took over meanwhile
    if (abandoned.has(op)) {
      this.#replace(op)
      return 0
    }
    const transferred = new Uint32Array(1)
    const ok = this.#k.GetOverlappedResult(this.#handle, op.bytes, transferred, 0)
    op.buffer = null
    return ok ? (transferred[0] ?? 0) : 0
  }

  // An operation that never completed keeps its OVERLAPPED and event forever;
  // give the port a fresh one so later I/O doesn't share them.
  #replace(op: Overlapped): void {
    const fresh = new Overlapped(createEvent(this.#k))
    if (op === this.#readOp) this.#readOp = fresh
    const slot = this.#writeOps.indexOf(op)
    if (slot !== -1) this.#writeOps[slot] = fresh
  }

  #queuedOutput(): number {
    const errors = new Uint32Array(1)
    const status = new Uint8Array(COMSTAT.size)
    if (!this.#k.ClearCommError(this.#handle, errors, status)) throw this.#failed('ClearCommError')
    return new DataView(status.buffer).getUint32(COMSTAT.cbOutQue, true)
  }

  #setLine(line: keyof LineLevels, level: boolean): void {
    if (line === 'dtr') this.#escape(level ? SETDTR : CLRDTR)
    else this.#escape(level ? SETRTS : CLRRTS)
    this.#lines[line] = level
  }

  #escape(fn: number): void {
    if (!this.#k.EscapeCommFunction(this.#handle, fn)) throw this.#failed('EscapeCommFunction')
  }

  #failed(syscall: string): SerialPortError {
    return win32Error(syscall, this.#k.GetLastError(), { path: this.path })
  }

  // Reads are where a vanished device shows up for certain (one is always
  // pending while the port is open), so only they mark the port as gone for good.
  #ioFailure(syscall: 'ReadFile' | 'WriteFile', error: number): SerialPortError {
    const failure = win32Error(syscall, error, { path: this.path })
    if (syscall === 'ReadFile' && failure.code === 'DISCONNECTED') this.#gone ??= failure
    return failure
  }

  #assertUsable(afterWait = false): void {
    if (this.#lifetime.closed) throw afterWait ? canceledError() : notOpenError(this.path)
    if (this.#gone) {
      throw new SerialPortError('DISCONNECTED', `Device disconnected: ${this.path}`, { cause: this.#gone })
    }
  }
}

// Line settings, reads that wait for a first byte, writes without timeouts, a
// big driver queue, and nothing left over from a previous user.
function configure(k: Kernel32, handle: Handle, path: string, options: ResolvedOpenOptions): void {
  k.SetupComm(handle, DRIVER_QUEUE_SIZE, DRIVER_QUEUE_SIZE) // a request; drivers may keep their own sizes

  const dcb = new Uint8Array(DCB.size)
  new DataView(dcb.buffer).setUint32(DCB.DCBlength, DCB.size, true)
  if (!k.GetCommState(handle, dcb)) {
    const error = k.GetLastError()
    if (error === ERROR_INVALID_FUNCTION || error === ERROR_NOT_SUPPORTED) {
      throw new SerialPortError('INVALID_ARGUMENT', `${path} is not a serial port`, { syscall: 'GetCommState', osCode: error })
    }
    throw win32Error('GetCommState', error, { path })
  }
  configureDcb(dcb, options)
  // DTR and RTS start down and are raised afterwards, DTR first (see set()):
  // drivers apply both from one SetCommState in their own order, and some
  // pass through DTR down with RTS up, resetting an ESP32 as the port opens.
  setLineControl(dcb, { dtr: false, rts: false }, options.rtscts)
  if (!k.SetCommState(handle, dcb)) {
    const error = k.GetLastError()
    if (error === ERROR_INVALID_PARAMETER) {
      throw new SerialPortError('UNSUPPORTED', `${path} rejected these settings (baud rate, data bits, parity or stop bits)`, {
        syscall: 'SetCommState',
        osCode: error,
      })
    }
    throw win32Error('SetCommState', error, { path })
  }
  if (!k.SetCommTimeouts(handle, commTimeouts(MAXDWORD, MAXDWORD, READ_WAIT_MS, 0, 0))) {
    throw win32Error('SetCommTimeouts', k.GetLastError(), { path })
  }
  k.PurgeComm(handle, PURGE_RXCLEAR | PURGE_TXCLEAR)
  const lines = initialLines(options)
  if (lines.dtr && !k.EscapeCommFunction(handle, SETDTR)) throw win32Error('EscapeCommFunction', k.GetLastError(), { path })
  if (lines.rts && !options.rtscts && !k.EscapeCommFunction(handle, SETRTS)) {
    throw win32Error('EscapeCommFunction', k.GetLastError(), { path })
  }
}

// A manual-reset event, as overlapped I/O requires.
function createEvent(k: Kernel32): Handle {
  const event = k.CreateEventW(null, 1, 0, null)
  if (!validHandle(event)) throw win32Error('CreateEventW', k.GetLastError())
  return event
}

// Wait for canceled operations to complete. Anything still pending after the
// grace period is abandoned: kept referenced forever rather than freed.
async function settle(ops: Overlapped[], api: Win32Api): Promise<void> {
  const deadline = performance.now() + CANCEL_GRACE_MS
  let pending = ops.filter((op) => op.pending)
  while (pending.length > 0 && performance.now() < deadline) {
    await within(deadline - performance.now(), Promise.all(pending.map((op) => op.completion(api))))
    pending = pending.filter((op) => op.pending)
  }
  for (const op of pending) {
    abandoned.add(op)
    op.unwatch()
  }
}

function within(ms: number, promise: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
