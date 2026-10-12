// Win32Port's state machine — overlapped reads and writes, chunking,
// stalls, cancellation, close, and waiting on completions rather than
// polling for them — against a simulated driver, on every OS.

import { describe, expect, test } from 'bun:test'
import { win32Capabilities } from '../src/bindings/win32/capabilities.js'
import {
  CLRDTR,
  CLRRTS,
  DCB,
  SETDTR,
  SETRTS,
  fDtrControlShift,
  fRtsControlShift,
  MAXDWORD,
  PURGE_RXCLEAR,
  PURGE_TXCLEAR,
} from '../src/bindings/win32/constants.js'
import { createWin32Binding } from '../src/bindings/win32/index.js'
import { Win32Port } from '../src/bindings/win32/port.js'
import { bytesInMs, transmitBudgetMs } from '../src/internal/timing.js'
import { resolveOpenOptions, type OpenOptions } from '../src/options.js'
import { SerialPort } from '../src/serial-port.js'
import { FakeComm, PORT_HANDLE } from './helpers/fake-kernel32.js'
import { rejectionCode } from './helpers/errors.js'

const decoder = new TextDecoder()

function open(fake: FakeComm, options: Partial<OpenOptions> = {}) {
  const resolved = resolveOpenOptions({ baudRate: 115200, ...options }, win32Capabilities)
  return { port: Win32Port.open('COM3', resolved, fake.api()), options: resolved }
}

function lineControl(fake: FakeComm) {
  const flags = new DataView(fake.dcb.buffer).getUint32(DCB.flags, true)
  return { dtr: (flags >> fDtrControlShift) & 0b11, rts: (flags >> fRtsControlShift) & 0b11 }
}

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff)
}

describe('open', () => {
  test('applies the DCB, reads that wait for a first byte, and a purge', async () => {
    const fake = new FakeComm()
    const { port } = open(fake, { baudRate: 57600 })
    expect(new DataView(fake.dcb.buffer).getUint32(DCB.BaudRate, true)).toBe(57600)
    expect(fake.dcb[DCB.ByteSize]).toBe(8)
    const timeouts = new DataView(fake.timeouts!.buffer)
    expect([0, 4, 8, 12, 16].map((offset) => timeouts.getUint32(offset, true))).toEqual([MAXDWORD, MAXDWORD, 1000, 0, 0])
    expect(fake.calls).toContain(`PurgeComm:${PURGE_RXCLEAR | PURGE_TXCLEAR}`)
    await port.close()
  })

  test('DTR and RTS go up one at a time after the DCB is set, DTR first', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    expect(lineControl(fake)).toEqual({ dtr: 0, rts: 0 }) // SetCommState left them down
    const setState = fake.calls.indexOf('SetCommState')
    expect(fake.calls.slice(setState).filter((call) => call.startsWith('EscapeCommFunction'))).toEqual([
      `EscapeCommFunction:${SETDTR}`,
      `EscapeCommFunction:${SETRTS}`,
    ])
    await port.close()
  })

  test('failures map to portable codes', () => {
    const fake = new FakeComm()
    fake.busy.add('COM4')
    fake.notSerial.add('NUL')
    const options = resolveOpenOptions({ baudRate: 9600 }, win32Capabilities)
    const code = (path: string) => {
      try {
        Win32Port.open(path, options, fake.api())
        return 'opened'
      } catch (err) {
        return (err as { code: string }).code
      }
    }
    expect(code('COM9')).toBe('NOT_FOUND')
    expect(code('COM4')).toBe('BUSY')
    expect(code('NUL')).toBe('INVALID_ARGUMENT')
    expect(fake.closedHandles.has(PORT_HANDLE)).toBe(true) // the non-serial handle was released
  })

  test('line settings a DCB cannot express are refused before opening', () => {
    const fake = new FakeComm()
    const options = resolveOpenOptions({ baudRate: 9600, dataBits: 8, stopBits: 1.5 }, win32Capabilities)
    expect(() => Win32Port.open('COM3', options, fake.api())).toThrow('1.5 stop bits')
    expect(fake.calls).toEqual([])
  })
})

describe('read', () => {
  test('returns what the device sent', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.receive(new TextEncoder().encode('hi'))
    const buffer = new Uint8Array(16)
    const count = await port.read(buffer)
    expect(decoder.decode(buffer.subarray(0, count))).toBe('hi')
    await port.close()
  })

  test('waits in the driver for data, without polling', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    const buffer = new Uint8Array(16)
    const read = port.read(buffer)
    await Bun.sleep(30)
    expect(fake.readCalls).toBe(1)
    fake.receive([0x41, 0x42])
    expect(await read).toBe(2)
    expect(decoder.decode(buffer.subarray(0, 2))).toBe('AB')
    await port.close()
  })

  test('a read wait that passes empty is issued again', async () => {
    const fake = new FakeComm()
    fake.readWaitMs = 10
    const { port } = open(fake)
    const read = port.read(new Uint8Array(16))
    await Bun.sleep(65)
    expect(fake.readCalls).toBeGreaterThanOrEqual(3)
    expect(fake.readCalls).toBeLessThanOrEqual(8)
    fake.receive([1])
    expect(await read).toBe(1)
    await port.close()
  })

  test('a driver that returns at once is polled every pollInterval', async () => {
    const fake = new FakeComm()
    fake.ignoresReadWait = true
    const { port } = open(fake, { pollInterval: 5 })
    const read = port.read(new Uint8Array(16))
    await Bun.sleep(60)
    expect(fake.readCalls).toBeGreaterThanOrEqual(3)
    expect(fake.readCalls).toBeLessThanOrEqual(14)
    fake.receive([1])
    expect(await read).toBe(1)
    await port.close()
  })

  test('an aborted read is canceled, and the next one works', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    const controller = new AbortController()
    const outcome = rejectionCode(port.read(new Uint8Array(16), controller.signal))
    await Bun.sleep(5)
    controller.abort()
    expect(await outcome).toBe('CANCELED')
    expect(fake.calls).toContain('CancelIoEx')
    const read = port.read(new Uint8Array(16))
    fake.receive([7])
    expect(await read).toBe(1)
    await port.close()
  })

  test('a read pending when the device fails rejects with the failure', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    const outcome = rejectionCode(port.read(new Uint8Array(16)))
    await Bun.sleep(5)
    fake.readError = 1167 // ERROR_DEVICE_NOT_CONNECTED
    expect(await outcome).toBe('DISCONNECTED')
    await port.close()
  })

  test('a failed read marks the port disconnected', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.readError = 31 // ERROR_GEN_FAILURE
    expect(await rejectionCode(port.read(new Uint8Array(16)))).toBe('DISCONNECTED')
    expect(await rejectionCode(port.write(Uint8Array.of(1)))).toBe('DISCONNECTED')
    await port.close()
  })

  test('close() ends a pending read with CANCELED', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    const outcome = rejectionCode(port.read(new Uint8Array(16)))
    await Bun.sleep(5)
    await port.close()
    expect(await outcome).toBe('CANCELED')
  })
})

describe('write', () => {
  test('goes out in order, in bounded chunks, two queued at a time', async () => {
    const fake = new FakeComm()
    const { port, options } = open(fake)
    const data = pattern(20000)
    await port.write(data)
    expect(fake.writtenBytes()).toEqual(data)
    const chunk = Math.max(64, bytesInMs(options, 200))
    expect(fake.written.length).toBe(Math.ceil(data.length / chunk))
    for (const piece of fake.written) expect(piece.length).toBeLessThanOrEqual(chunk)
    expect(fake.maxPendingWrites).toBe(2)
    await port.close()
  })

  test('a held write times out after its transmission budget plus writeTimeout', async () => {
    const fake = new FakeComm()
    const { port, options } = open(fake, { writeTimeout: 100 })
    fake.stalled = true
    const started = performance.now()
    expect(await rejectionCode(port.write(pattern(10)))).toBe('TIMEOUT')
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(transmitBudgetMs(options, 10) + 100 - 5)
    expect(fake.calls).toContain('CancelIoEx')
    fake.stalled = false
    await port.write(pattern(10)) // the port still works
    await port.close()
  })

  test('an aborted signal is honored only once the write has outlasted its transmission time', async () => {
    const fake = new FakeComm()
    const { port, options } = open(fake, { writeTimeout: Infinity })
    fake.stalled = true
    const controller = new AbortController()
    controller.abort()
    const started = performance.now()
    expect(await rejectionCode(port.write(pattern(10), controller.signal))).toBe('CANCELED')
    expect(performance.now() - started).toBeGreaterThanOrEqual(transmitBudgetMs(options, 10) - 5)
    await port.close()
  })

  test('a write within its transmission time completes even if the signal aborts', async () => {
    const fake = new FakeComm()
    fake.writeLatencyMs = 30
    const { port } = open(fake)
    const controller = new AbortController()
    const write = port.write(pattern(10), controller.signal)
    controller.abort()
    await write
    expect(fake.writtenBytes()).toEqual(pattern(10))
    await port.close()
  })

  test('close() during a held write cancels it and releases every handle', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.stalled = true
    const read = rejectionCode(port.read(new Uint8Array(16)))
    const outcome = rejectionCode(port.write(pattern(5000)))
    await Bun.sleep(10)
    expect(fake.activeWatches).toBe(2) // the read and the oldest write
    await port.close()
    expect(await outcome).toBe('CANCELED')
    expect(await read).toBe('CANCELED')
    expect(fake.calls).toContain('CancelIoEx:all')
    expect(fake.closedHandles.has(PORT_HANDLE)).toBe(true)
    expect(fake.closedHandles.size).toBe(4) // the port and its three events
    expect(fake.activeWatches).toBe(0)
    expect(fake.closedWhileWatched).toEqual([])
  })
})

describe('modem lines', () => {
  test('update() keeps DTR and RTS where set() left them', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    await port.set({ dtr: false })
    await port.update({ baudRate: 9600 })
    expect(new DataView(fake.dcb.buffer).getUint32(DCB.BaudRate, true)).toBe(9600)
    expect(lineControl(fake)).toEqual({ dtr: 0, rts: 1 })
    await port.close()
  })

  test('hupcl: false never raises DTR or RTS, and close leaves them alone', async () => {
    const fake = new FakeComm()
    const { port } = open(fake, { hupcl: false })
    expect(lineControl(fake)).toEqual({ dtr: 0, rts: 0 })
    await port.close()
    expect(fake.calls.filter((call) => call.startsWith('EscapeCommFunction'))).toEqual([])
  })

  test('close lowers RTS before DTR', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.calls.length = 0
    await port.close()
    expect(fake.calls.filter((call) => call.startsWith('EscapeCommFunction'))).toEqual([
      `EscapeCommFunction:${CLRRTS}`,
      `EscapeCommFunction:${CLRDTR}`,
    ])
  })

  test('set() never passes through DTR down with RTS up on the way to another state', async () => {
    const fake = new FakeComm()
    const { port } = open(fake, { hupcl: false })
    const steps = async (lines: { dtr: boolean; rts: boolean }) => {
      fake.calls.length = 0
      await port.set(lines)
      return fake.calls.map((call) => Number(call.replace('EscapeCommFunction:', '')))
    }
    expect(await steps({ dtr: true, rts: true })).toEqual([SETDTR, SETRTS]) // from both down
    expect(await steps({ dtr: false, rts: false })).toEqual([CLRRTS, CLRDTR]) // from both up
    expect(await steps({ dtr: true, rts: false })).toEqual([SETDTR, CLRRTS]) // esptool's "IO0 low"
    expect(await steps({ dtr: false, rts: true })).toEqual([SETRTS, CLRDTR]) // esptool's "reset"
    await port.close()
  })

  test('RTS belongs to the driver under rtscts', async () => {
    const fake = new FakeComm()
    const { port } = open(fake, { rtscts: true })
    expect(lineControl(fake).rts).toBe(2)
    expect(await rejectionCode(port.set({ rts: false }))).toBe('UNSUPPORTED')
    await port.close()
  })

  test('get() decodes the modem status bits', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.modemStatus = 0x10 | 0x80 // CTS, RLSD
    expect(await port.get()).toEqual({ cts: true, dsr: false, dcd: true, ri: false })
    await port.close()
  })
})

describe('drain', () => {
  test('waits for the driver queue to empty, then flushes', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.extraOutQueue = 100
    let drained = false
    const drain = port.drain().then(() => {
      drained = true
    })
    await Bun.sleep(20)
    expect(drained).toBe(false)
    fake.extraOutQueue = 0
    await drain
    expect(fake.calls).toContain('FlushFileBuffers')
    await port.close()
  })

  test('looks at the queue less and less often while it waits', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.extraOutQueue = 100
    const drain = port.drain()
    await Bun.sleep(200)
    fake.extraOutQueue = 0
    await drain
    expect(fake.queueChecks).toBeLessThan(45) // 1 ms polling would be ~200
    await port.close()
  })

  test('a failed FlushFileBuffers rejects IO', async () => {
    const fake = new FakeComm()
    const { port } = open(fake)
    fake.flushFails = true
    expect(await rejectionCode(port.drain())).toBe('IO')
    await port.close()
  })

  test('gives up after the transmission budget once the signal aborts', async () => {
    const fake = new FakeComm()
    const { port, options } = open(fake, { baudRate: 921600 })
    fake.extraOutQueue = 100
    const controller = new AbortController()
    controller.abort()
    const started = performance.now()
    expect(await rejectionCode(port.drain(controller.signal))).toBe('CANCELED')
    expect(performance.now() - started).toBeGreaterThanOrEqual(transmitBudgetMs(options, 100 + 4096) - 5)
    expect(fake.calls).toContain(`PurgeComm:${PURGE_TXCLEAR}`)
    await port.close()
  })
})

describe('through SerialPort', () => {
  test('a write followed at once by close() still goes out', async () => {
    const fake = new FakeComm()
    fake.writeLatencyMs = 15
    const port = new SerialPort({ path: 'COM3', baudRate: 115200, binding: createWin32Binding(fake.api()) })
    const write = port.write('bye')
    await port.close()
    await write
    expect(decoder.decode(fake.writtenBytes())).toBe('bye')
  })

  test('incoming bytes become data events, and a failed read closes the port', async () => {
    const fake = new FakeComm()
    const port = new SerialPort({ path: 'COM3', baudRate: 115200, binding: createWin32Binding(fake.api()) })
    const data = new Promise<Uint8Array>((resolve) => port.once('data', resolve))
    await new Promise<void>((resolve) => port.once('open', () => resolve()))
    fake.receive(new TextEncoder().encode('ok'))
    expect(decoder.decode(await data)).toBe('ok')

    const closed = new Promise<unknown>((resolve) => port.once('close', resolve))
    port.on('error', () => {})
    fake.readError = 1167 // ERROR_DEVICE_NOT_CONNECTED
    expect(((await closed) as { code: string }).code).toBe('DISCONNECTED')
    expect(port.isOpen).toBe(false)
  })
})
