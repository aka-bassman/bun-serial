// A named pipe standing in for a COM port, so Win32Port runs on real
// overlapped I/O without serial hardware. The port's end makes every real
// kernel32 call — ReadFile, WriteFile, GetOverlappedResult, CancelIoEx,
// CreateEventW, CloseHandle — waits on its events through the thread pool,
// and runs FlushFileBuffers and the final CloseHandle on threads of their
// own, as on a COM port. Only the comm-specific calls a pipe can't answer are
// simulated: GetCommState and friends succeed, and ClearCommError reports the
// bytes waiting in the pipe as the output queue. A worker serves the other
// end as the device (pipe-device.ts). Windows only; nothing loads until a
// PipeDevice is made.

import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { COMSTAT, DCB } from '../../src/bindings/win32/constants.js'
import { kernel32, validHandle, type Kernel32Api } from '../../src/bindings/win32/ffi.js'
import { systemApi, type Win32Api } from '../../src/bindings/win32/port.js'
import { wide } from '../../src/bindings/win32/structs.js'
import type { DeviceMode, DeviceReply, DeviceRequest } from './pipe-device.js'

const PIPE_ACCESS_DUPLEX = 3
const PIPE_BYTE_MODE = 0 // PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT

const ptr = FFIType.ptr
const u32 = FFIType.u32
const i32 = FFIType.i32
let pipeApi: ReturnType<typeof loadPipeApi> | undefined
function loadPipeApi() {
  return dlopen('kernel32.dll', {
    CreateNamedPipeW: { args: [ptr, u32, u32, u32, u32, u32, u32, ptr], returns: ptr },
    PeekNamedPipe: { args: [ptr, ptr, u32, ptr, ptr, ptr], returns: i32 },
    ReadFile: { args: [ptr, ptr, u32, ptr, ptr], returns: i32 },
    CloseHandle: { args: [ptr], returns: i32 },
    GetCurrentProcess: { args: [], returns: ptr },
    GetProcessHandleCount: { args: [ptr, ptr], returns: i32 },
  }).symbols
}
function pipes() {
  return (pipeApi ??= loadPipeApi())
}

export interface DeviceStats {
  /** Bytes the device has taken. */
  count: number
  /** FNV-1a of those bytes; compare with fnv1a(). */
  hash: number
}

export interface PipeDeviceOptions {
  mode?: DeviceMode
  /** Bytes per ms the device takes; 0 is as fast as it can. */
  rate?: number
  /** The pipe's buffer, in bytes: how much the device holds before writes pend. */
  bufferSize?: number
  /** Without a worker nothing serves the pipe; use readWaiting(). */
  worker?: boolean
}

let sequence = 0

export class PipeDevice {
  readonly name = `\\\\.\\pipe\\bun-serial-test-${process.pid}-${++sequence}`
  readonly ready: Promise<void>
  /** Report an empty output queue, so drain() goes straight to FlushFileBuffers. */
  hideQueue = false
  /** Flags of every PurgeComm the port made. */
  readonly purges: number[] = []
  /** ReadFile calls the port made, to tell waiting from polling. */
  readCalls = 0
  readonly #server: Pointer
  readonly #queued = new Int32Array(new SharedArrayBuffer(4))
  readonly #worker: Worker | null
  readonly #waiters = new Map<number, (stats: DeviceStats) => void>()
  #nextId = 1

  constructor({ mode = 'sink', rate = 0, bufferSize = 4096, worker = true }: PipeDeviceOptions = {}) {
    const server = pipes().CreateNamedPipeW(wide(this.name), PIPE_ACCESS_DUPLEX, PIPE_BYTE_MODE, 1, bufferSize, bufferSize, 0, null)
    if (!validHandle(server)) throw new Error(`CreateNamedPipeW failed: ${kernel32().GetLastError()}`)
    this.#server = server
    if (!worker) {
      this.#worker = null
      this.ready = Promise.resolve()
      return
    }
    this.#worker = new Worker(new URL('./pipe-device.ts', import.meta.url).href)
    let ready!: () => void
    this.ready = new Promise((resolve) => (ready = resolve))
    this.#worker.onmessage = (event: MessageEvent<DeviceReply>) => {
      const reply = event.data
      if (reply.type === 'ready') ready()
      else if (reply.type === 'stats') {
        this.#waiters.get(reply.id)?.({ count: reply.count, hash: reply.hash })
        this.#waiters.delete(reply.id)
      }
    }
    this.#post({ type: 'init', server, queued: this.#queued.buffer, mode, rate })
  }

  mode(mode: DeviceMode, rate = 0): void {
    this.#post({ type: 'mode', mode, rate })
  }

  /** The device sends `data` to the port. */
  send(data: Uint8Array): void {
    this.#post({ type: 'send', data })
  }

  stats(): Promise<DeviceStats> {
    const id = this.#nextId++
    return new Promise((resolve) => {
      this.#waiters.set(id, resolve)
      this.#post({ type: 'stats', id })
    })
  }

  /** Without a worker: take whatever is waiting in the pipe, returning its length. */
  readWaiting(): number {
    const available = new Uint32Array(1)
    pipes().PeekNamedPipe(this.#server, null, 0, null, available, null)
    const length = available[0] ?? 0
    if (length === 0) return 0
    const transferred = new Uint32Array(1)
    pipes().ReadFile(this.#server, new Uint8Array(length), length, transferred, null)
    return transferred[0] ?? 0
  }

  /** The OS for Win32Port: real kernel32 on the pipe, simulated comm calls. */
  api(): Win32Api {
    const real = kernel32()
    const device = this
    const shim: Kernel32Api = {
      CreateFileW: (_name, access, share, security, disposition, flags, template) =>
        real.CreateFileW(wide(device.name), access, share, security, disposition, flags, template),
      CloseHandle: (handle) => real.CloseHandle(handle),
      GetLastError: () => real.GetLastError(),
      GetCommState(_handle, dcb) {
        new DataView(dcb.buffer, dcb.byteOffset, dcb.byteLength).setUint32(DCB.DCBlength, DCB.size, true)
        return 1
      },
      SetCommState: () => 1,
      SetCommTimeouts: () => 1,
      SetupComm: () => 1,
      ReadFile(handle, buffer, length, transferred, overlapped) {
        device.readCalls++
        return real.ReadFile(handle, buffer, length, transferred, overlapped)
      },
      WriteFile: (handle, buffer, length, transferred, overlapped) => real.WriteFile(handle, buffer, length, transferred, overlapped),
      GetOverlappedResult: (handle, overlapped, transferred, wait) => real.GetOverlappedResult(handle, overlapped, transferred, wait),
      CancelIoEx: (handle, overlapped) => real.CancelIoEx(handle, overlapped),
      CreateEventW: (security, manualReset, initialState, name) => real.CreateEventW(security, manualReset, initialState, name),
      EscapeCommFunction: () => 1,
      GetCommModemStatus(_handle, status) {
        status[0] = 0
        return 1
      },
      PurgeComm(_handle, flags) {
        device.purges.push(flags)
        return 1
      },
      ClearCommError(_handle, errors, status) {
        errors[0] = 0
        const queued = device.hideQueue ? 0 : Atomics.load(device.#queued, 0)
        new DataView(status.buffer, status.byteOffset, status.byteLength).setUint32(COMSTAT.cbOutQue, queued, true)
        return 1
      },
    }
    return { ...systemApi(), kernel32: shim }
  }

  /** The device goes away: its worker stops and its end of the pipe closes. */
  dispose(): void {
    this.#worker?.terminate()
    pipes().CloseHandle(this.#server)
  }

  #post(request: DeviceRequest): void {
    this.#worker?.postMessage(request)
  }
}

export function processHandleCount(): number {
  const count = new Uint32Array(1)
  pipes().GetProcessHandleCount(pipes().GetCurrentProcess(), count)
  return count[0] ?? 0
}

export function fnv1a(data: Uint8Array): number {
  let hash = 0x811c9dc5
  for (const byte of data) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash >>> 0
}
