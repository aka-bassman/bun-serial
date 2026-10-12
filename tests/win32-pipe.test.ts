// Win32Port and SerialPort on real overlapped I/O: a named pipe stands in for
// the COM port (helpers/pipe-port.ts), so every ReadFile, WriteFile,
// CancelIoEx and FlushFileBuffers here is a real kernel call on a real
// handle, and every completion arrives through the thread pool. Windows only;
// needs no serial ports.

import { describe, expect, test } from 'bun:test'
import { createWin32Binding } from '../src/bindings/win32/index.js'
import { transmitBudgetMs } from '../src/internal/timing.js'
import type { SerialPortOptions } from '../src/options.js'
import { SerialPort } from '../src/serial-port.js'
import { rejectionCode } from './helpers/errors.js'
import { fnv1a, PipeDevice, processHandleCount, type PipeDeviceOptions } from './helpers/pipe-port.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const LINE_115200 = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' } as const

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7 + (i >> 8)) & 0xff)
}

function portOn(device: PipeDevice, options: Partial<SerialPortOptions> = {}): SerialPort {
  return new SerialPort({ path: 'COM99', baudRate: 921600, binding: createWin32Binding(device.api()), ...options })
}

function opened(port: SerialPort): Promise<void> {
  return port.isOpen ? Promise.resolve() : new Promise((resolve) => port.once('open', () => resolve()))
}

// Run with an open port on a fresh device; both are released even if `run` throws.
async function withPort(
  deviceOptions: PipeDeviceOptions,
  portOptions: Partial<SerialPortOptions>,
  run: (port: SerialPort, device: PipeDevice) => Promise<void>,
): Promise<void> {
  const device = new PipeDevice(deviceOptions)
  await device.ready
  const port = portOn(device, portOptions)
  try {
    await opened(port)
    await run(port, device)
  } finally {
    if (port.isOpen) await port.close()
    device.dispose()
  }
}

// Data events until `length` bytes have arrived or `timeoutMs` passes.
function collect(port: SerialPort, length: number, timeoutMs = 5000): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = []
    let total = 0
    const done = () => {
      port.off('data', onData)
      clearTimeout(timer)
      const out = new Uint8Array(total)
      let at = 0
      for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
      }
      resolve(out)
    }
    const onData = (chunk: Uint8Array) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= length) done()
    }
    const timer = setTimeout(done, timeoutMs)
    port.on('data', onData)
  })
}

describe.if(process.platform === 'win32')('win32 binding over a named pipe', () => {
  test('bytes the device sends become data events', () =>
    withPort({}, {}, async (port, device) => {
      const received = collect(port, 6)
      device.send(encoder.encode('hello\n'))
      expect(decoder.decode(await received)).toBe('hello\n')
    }))

  test('an idle port waits for data without polling', () =>
    withPort({}, {}, async (port, device) => {
      await Bun.sleep(20)
      const before = device.readCalls
      await Bun.sleep(300)
      expect(device.readCalls).toBe(before) // one ReadFile, still pending
      const received = collect(port, 3)
      device.send(encoder.encode('hey'))
      expect(decoder.decode(await received)).toBe('hey')
    }))

  test('1 MiB arrives intact, and drain() resolves once the device has all of it', () =>
    withPort({}, {}, async (port, device) => {
      const data = pattern(1 << 20)
      await port.write(data)
      await port.drain()
      expect(await device.stats()).toEqual({ count: data.length, hash: fnv1a(data) })
    }))

  test('a loopback device echoes 256 KiB back byte for byte', () =>
    withPort({ mode: 'echo' }, {}, async (port) => {
      const data = pattern(256 * 1024)
      const received = collect(port, data.length)
      await port.write(data)
      expect(await received).toEqual(data)
    }))

  test('drain() takes as long as the device takes the bytes', () =>
    withPort({ rate: 115200 / 10 / 1000 }, { baudRate: 115200 }, async (port, device) => {
      const data = pattern(4608) // 400 ms of line time
      const started = performance.now()
      await port.write(data)
      await port.drain()
      expect(performance.now() - started).toBeGreaterThanOrEqual(350)
      expect((await device.stats()).count).toBe(data.length)
    }))

  test('drain() waits on FlushFileBuffers, on its thread, until the device reads', () =>
    withPort({ mode: 'paused' }, { baudRate: 115200 }, async (port, device) => {
      device.hideQueue = true
      await port.write(pattern(1000))
      let drained = false
      const drain = port.drain().then(() => {
        drained = true
      })
      await Bun.sleep(150)
      expect(drained).toBe(false)
      device.mode('sink')
      await drain
      expect((await device.stats()).count).toBe(1000)
    }))

  test('a write the device stops taking rejects TIMEOUT, and the port keeps working', () =>
    withPort({ mode: 'paused' }, { baudRate: 115200, writeTimeout: 300 }, async (port, device) => {
      expect(await rejectionCode(port.write(pattern(64 * 1024)))).toBe('TIMEOUT')
      device.mode('sink')
      await Bun.sleep(100)
      const before = (await device.stats()).count
      await port.write(encoder.encode('still alive'))
      await port.drain()
      expect((await device.stats()).count - before).toBe(11)
    }))

  test('close() gives up on output the device never takes', () =>
    withPort({ mode: 'paused' }, { baudRate: 115200, writeTimeout: Infinity }, async (port) => {
      const write = rejectionCode(port.write(pattern(64 * 1024)))
      await Bun.sleep(50)
      const started = performance.now()
      await port.close()
      expect(performance.now() - started).toBeLessThan(3000)
      expect(await write).toBe('CANCELED')
    }))

  test('close() ends a FlushFileBuffers stuck on its thread', () =>
    withPort({ mode: 'paused' }, { baudRate: 115200 }, async (port, device) => {
      device.hideQueue = true
      await port.write(pattern(100))
      const drain = rejectionCode(port.drain())
      await Bun.sleep(100)
      const started = performance.now()
      await port.close()
      const elapsed = performance.now() - started
      expect(await drain).toBe('CANCELED')
      expect(elapsed).toBeGreaterThanOrEqual(transmitBudgetMs(LINE_115200, 4096) - 50)
      expect(elapsed).toBeLessThan(3000)
    }))

  test('close() cancels a pending read at once', () =>
    withPort({}, {}, async (port) => {
      await Bun.sleep(20)
      const started = performance.now()
      await port.close()
      expect(performance.now() - started).toBeLessThan(500)
    }))

  test('a vanished device surfaces as error, then close carrying it', async () => {
    const device = new PipeDevice()
    await device.ready
    const port = portOn(device)
    await opened(port)
    const errors: unknown[] = []
    port.on('error', (err) => errors.push(err))
    const closed = new Promise<unknown>((resolve) => port.once('close', resolve))
    device.dispose()
    const cause = await closed
    expect(port.isOpen).toBe(false)
    expect(errors).toEqual([cause])
  })

  test('opening and closing leaks no handles', async () => {
    const cycle = async () => {
      const device = new PipeDevice({ worker: false, bufferSize: 65536 })
      const port = portOn(device)
      try {
        await opened(port)
        await port.write(pattern(10))
        expect(device.readWaiting()).toBe(10)
      } finally {
        await port.close()
        device.dispose()
      }
    }
    for (let i = 0; i < 5; i++) await cycle() // warm up the thread pool and lazy DLLs
    const before = processHandleCount()
    for (let i = 0; i < 100; i++) await cycle()
    expect(processHandleCount() - before).toBeLessThan(10)
  })
})
