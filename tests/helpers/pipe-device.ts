// Worker: the server end of the named pipe in pipe-port.ts, standing in for a
// serial device. Blocking FFI is fine here — this thread is the device.
//
// Modes: 'paused' takes nothing (a device holding CTS low), 'sink' takes and
// counts, 'echo' sends everything back (a loopback plug). `rate` paces how
// fast the device takes bytes, in bytes per ms; 0 is as fast as it can.

import { dlopen, FFIType, type Pointer } from 'bun:ffi'

export type DeviceMode = 'paused' | 'sink' | 'echo'

export type DeviceRequest =
  | { type: 'init'; server: Pointer; queued: SharedArrayBuffer; mode: DeviceMode; rate: number }
  | { type: 'mode'; mode: DeviceMode; rate: number }
  | { type: 'send'; data: Uint8Array }
  | { type: 'stats'; id: number }

export type DeviceReply =
  | { type: 'ready' }
  | { type: 'stats'; id: number; count: number; hash: number }
  | { type: 'closed'; code: number }

declare const self: Worker

const ptr = FFIType.ptr
const u32 = FFIType.u32
const i32 = FFIType.i32
const k = dlopen('kernel32.dll', {
  ReadFile: { args: [ptr, ptr, u32, ptr, ptr], returns: i32 },
  WriteFile: { args: [ptr, ptr, u32, ptr, ptr], returns: i32 },
  PeekNamedPipe: { args: [ptr, ptr, u32, ptr, ptr, ptr], returns: i32 },
  GetLastError: { args: [], returns: u32 },
}).symbols

const ERROR_BAD_PIPE = 230
const ERROR_PIPE_LISTENING = 536

let queued: Int32Array = new Int32Array(1)
let mode: DeviceMode = 'sink'
let rate = 0
let credit = 0
let count = 0
let hash = 0x811c9dc5
const outbox: Uint8Array[] = []
const buffer = new Uint8Array(1 << 20)
const transferred = new Uint32Array(1)
const available = new Uint32Array(1)

self.onmessage = (event: MessageEvent<DeviceRequest>) => {
  const request = event.data
  switch (request.type) {
    case 'init':
      queued = new Int32Array(request.queued)
      mode = request.mode
      rate = request.rate
      reply({ type: 'ready' })
      void serve(request.server)
      break
    case 'mode':
      mode = request.mode
      rate = request.rate
      credit = 0
      break
    case 'send':
      outbox.push(request.data)
      break
    case 'stats':
      reply({ type: 'stats', id: request.id, count, hash: hash >>> 0 })
      break
  }
}

function reply(message: DeviceReply): void {
  self.postMessage(message)
}

async function serve(pipe: Pointer): Promise<void> {
  let connected = false
  let last = performance.now()
  for (;;) {
    if (!k.PeekNamedPipe(pipe, null, 0, null, available, null)) {
      const code = k.GetLastError()
      // Until the port opens its end, the pipe is only listening.
      if (!connected && (code === ERROR_BAD_PIPE || code === ERROR_PIPE_LISTENING)) {
        await Bun.sleep(1)
        continue
      }
      reply({ type: 'closed', code })
      return
    }
    connected = true
    const waiting = available[0] ?? 0
    Atomics.store(queued, 0, waiting)

    const now = performance.now()
    const elapsed = now - last
    last = now
    if (waiting > 0 && mode !== 'paused') {
      let take = waiting
      if (rate > 0) {
        credit = Math.min(credit + elapsed * rate, rate * 5 + 1)
        take = Math.min(waiting, Math.floor(credit))
      }
      if (take > 0) {
        if (!k.ReadFile(pipe, buffer, Math.min(take, buffer.length), transferred, null)) {
          reply({ type: 'closed', code: k.GetLastError() })
          return
        }
        const chunk = buffer.subarray(0, transferred[0] ?? 0)
        credit -= chunk.length
        account(chunk)
        if (mode === 'echo' && !writeAll(pipe, chunk)) return
      }
    }
    for (let data = outbox.shift(); data; data = outbox.shift()) {
      if (!writeAll(pipe, data)) return
    }
    await Bun.sleep(1)
  }
}

function account(chunk: Uint8Array): void {
  count += chunk.length
  let h = hash
  for (const byte of chunk) h = Math.imul(h ^ byte, 0x01000193)
  hash = h
}

function writeAll(pipe: Pointer, data: Uint8Array): boolean {
  for (let at = 0; at < data.length; ) {
    const rest = data.subarray(at)
    if (!k.WriteFile(pipe, rest, rest.length, transferred, null)) {
      reply({ type: 'closed', code: k.GetLastError() })
      return false
    }
    at += transferred[0] ?? 0
  }
  return true
}
