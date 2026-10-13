// SerialPort's lifecycle, output ordering and events, against the in-memory
// binding — runs on every OS, no hardware.

import { describe, expect, test } from 'bun:test'
import { MockBinding } from '../src/bindings/mock/index.js'
import { isSerialPortError, type SerialPortError } from '../src/errors.js'
import { resolveOpenOptions, type SerialPortOptions } from '../src/options.js'
import { delimiterParser, readlineParser } from '../src/parsers/index.js'
import { SerialPort, type SerialPortEvents } from '../src/serial-port.js'
import { errorCode, rejectionCode } from './helpers/errors.js'

const decoder = new TextDecoder()
const PATH = '/dev/mock0'

function setup(options: Partial<SerialPortOptions> = {}) {
  const binding = new MockBinding()
  const device = binding.addPort(PATH)
  const port = new SerialPort({ path: PATH, baudRate: 9600, autoOpen: false, binding, ...options })
  return { binding, device, port }
}

async function opened(options?: Parameters<typeof setup>[0]) {
  const context = setup(options)
  await context.port.open()
  return context
}

describe('construction', () => {
  test('path and baudRate are required', () => {
    const binding = new MockBinding()
    // @ts-expect-error JS callers can omit anything
    expect(errorCode(() => new SerialPort({ baudRate: 9600, binding }))).toBe('INVALID_ARGUMENT')
    // @ts-expect-error JS callers can omit anything
    expect(errorCode(() => new SerialPort({ path: PATH, binding }))).toBe('INVALID_ARGUMENT')
  })

  test('invalid options throw before any hardware is touched', () => {
    const binding = new MockBinding()
    const make = (options: object) => () => new SerialPort({ path: PATH, baudRate: 9600, binding, ...options })
    expect(errorCode(make({ readBufferSize: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ autoOpen: 'yes' }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ hupcl: 'no' }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ binding: {} }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ maxQueuedWrites: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ maxQueuedWrites: 1.5 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ maxQueuedWrites: '8' }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ onListenerError: 'log' }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(make({ autoOpen: false, maxQueuedWrites: Infinity, onListenerError: () => {} }))).toBeUndefined()
  })

  test('exposes path and baudRate, and starts closed', () => {
    const { port } = setup()
    expect(port.path).toBe(PATH)
    expect(port.baudRate).toBe(9600)
    expect(port.isOpen).toBe(false)
  })
})

describe('when not open', () => {
  test('every operation rejects NOT_OPEN', async () => {
    const { port } = setup()
    expect(await rejectionCode(port.write('x'))).toBe('NOT_OPEN')
    expect(await rejectionCode(port.drain())).toBe('NOT_OPEN')
    expect(await rejectionCode(port.update({ baudRate: 19200 }))).toBe('NOT_OPEN')
    expect(await rejectionCode(port.set({ dtr: true }))).toBe('NOT_OPEN')
    expect(await rejectionCode(port.get())).toBe('NOT_OPEN')
    expect(await rejectionCode(port.flush())).toBe('NOT_OPEN')
    expect(await rejectionCode(port.close())).toBe('NOT_OPEN')
  })
})

describe('open', () => {
  test('emits open and reports isOpen', async () => {
    const { port, device } = setup()
    const openEvent = new Promise<void>((resolve) => port.once('open', resolve))
    await port.open()
    await openEvent
    expect(port.isOpen).toBe(true)
    expect(device.isOpen).toBe(true)
    await port.close()
  })

  test('opening twice is ALREADY_OPEN; concurrent opens share one attempt', async () => {
    const { port } = setup()
    const first = port.open()
    expect(port.open()).toBe(first)
    await first
    expect(await rejectionCode(port.open())).toBe('ALREADY_OPEN')
    await port.close()
  })

  test('autoOpen opens on the next microtask, and early writes wait for it', async () => {
    const binding = new MockBinding()
    const device = binding.addPort(PATH)
    const port = new SerialPort({ path: PATH, baudRate: 9600, binding })
    expect(device.isOpen).toBe(false)
    await port.write('early')
    expect(decoder.decode(device.takeWritten())).toBe('early')
    await port.close()
  })

  test('a failed autoOpen is reported as an error event', async () => {
    const port = new SerialPort({ path: '/dev/missing', baudRate: 9600, binding: new MockBinding() })
    const error = await new Promise<SerialPortError>((resolve) => port.once('error', resolve))
    expect(error.code).toBe('NOT_FOUND')
    expect(port.isOpen).toBe(false)
  })

  test('the port can be reopened, keeping a baud rate set by update()', async () => {
    const { port, device } = await opened()
    await port.update({ baudRate: 115200 })
    await port.close()
    await port.open()
    expect(device.options?.baudRate).toBe(115200)
    await port.close()
  })

  test('open() during close() waits, then reopens', async () => {
    const { port, device } = await opened()
    const closing = port.close()
    const reopening = port.open()
    await closing
    await reopening
    expect(port.isOpen).toBe(true)
    expect(device.isOpen).toBe(true)
    await port.close()
  })
})

describe('data', () => {
  test('incoming bytes arrive as data events', async () => {
    const { port, device } = await opened()
    const chunk = new Promise<Uint8Array>((resolve) => port.once('data', resolve))
    device.emit('hello')
    expect(decoder.decode(await chunk)).toBe('hello')
    await port.close()
  })

  test('without onListenerError, listener exceptions surface as uncaught exceptions, not a disconnect', async () => {
    // bun:test fails whichever test an uncaught exception lands in, so this runs in a child process.
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/throwing-listener.ts`], { stdout: 'pipe' })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toEqual({
      uncaught: ['listener failed', 'handler failed: open listener failed', 'No such port: /dev/missing'],
      calls: 2,
      seen: 2,
      open: true,
      opened: true,
    })
  })

  test('pipe() feeds a parser until unpipe()', async () => {
    const { port, device } = await opened()
    const lines: string[] = []
    const parser = port.pipe(readlineParser())
    parser.on('data', (line) => lines.push(line))
    expect(port.pipe(parser)).toBe(parser) // piping twice doesn't double-feed

    device.emit('one\ntw')
    device.emit('o\n')
    await Bun.sleep(5)
    expect(lines).toEqual(['one', 'two'])

    port.unpipe(parser)
    device.emit('three\n')
    await Bun.sleep(5)
    expect(lines).toEqual(['one', 'two'])
    await port.close()
  })
})

describe('onListenerError', () => {
  function recording() {
    const failures: { message: string; event: keyof SerialPortEvents }[] = []
    const onListenerError = (error: unknown, event: keyof SerialPortEvents) => {
      failures.push({ message: (error as Error).message, event })
    }
    return { failures, onListenerError }
  }

  test('receives what a listener threw; the other listeners still run and reading goes on', async () => {
    const { failures, onListenerError } = recording()
    const { port, device } = await opened({ onListenerError })
    const chunks: string[] = []
    port.on('data', (chunk) => {
      throw new Error(`failed on ${decoder.decode(chunk)}`)
    })
    port.on('data', (chunk) => chunks.push(decoder.decode(chunk)))

    device.emit('a')
    await Bun.sleep(5)
    device.emit('b')
    await Bun.sleep(5)
    expect(chunks).toEqual(['a', 'b'])
    expect(failures).toEqual([
      { message: 'failed on a', event: 'data' },
      { message: 'failed on b', event: 'data' },
    ])
    expect(port.isOpen).toBe(true)
    await port.close()
  })

  test("receives what a piped parser's listener threw, and the parser loses no message", async () => {
    const { failures, onListenerError } = recording()
    const { port, device } = await opened({ onListenerError })
    const frames: number[][] = []
    const parser = port.pipe(delimiterParser({ delimiter: [0x55, 0xaa] }))
    parser.on('data', (frame) => {
      if (frame[0] === 1) throw new Error('bad frame')
    })
    parser.on('data', (frame) => frames.push([...frame]))

    device.emit(Uint8Array.of(1, 0x55, 0xaa, 2, 0x55, 0xaa, 3, 0x55, 0xaa))
    await Bun.sleep(5)
    expect(frames).toEqual([[1], [2], [3]])
    expect(failures).toEqual([{ message: 'bad frame', event: 'data' }])
    await port.close()
  })

  test('covers open, close and error listeners too', async () => {
    const { failures, onListenerError } = recording()
    const { port, device } = setup({ onListenerError })
    for (const event of ['open', 'close', 'error'] as const) {
      port.on(event, () => {
        throw new Error(`${event} listener failed`)
      })
    }
    await port.open()
    const closed = new Promise((resolve) => port.once('close', resolve))
    device.disconnect()
    await closed
    expect(failures).toEqual([
      { message: 'open listener failed', event: 'open' },
      { message: 'error listener failed', event: 'error' },
      { message: 'close listener failed', event: 'close' },
    ])
  })
})

describe('write', () => {
  test('writes reach the device in call order', async () => {
    const { port, device } = await opened()
    await Promise.all([port.write('a'), port.write('b'), port.write('c')])
    expect(decoder.decode(device.takeWritten())).toBe('abc')
    await port.close()
  })

  test('accepts strings, byte arrays, ArrayBuffers and views', async () => {
    const { port, device } = await opened()
    await port.write('A')
    await port.write([0x42])
    await port.write(Uint8Array.of(0x43).buffer)
    await port.write(new DataView(Uint8Array.of(0x44).buffer))
    expect(decoder.decode(device.takeWritten())).toBe('ABCD')
    await port.close()
  })

  test('rejects data that is not bytes', async () => {
    const { port } = await opened()
    expect(await rejectionCode(port.write([256]))).toBe('INVALID_ARGUMENT')
    // @ts-expect-error JS callers can pass anything
    expect(await rejectionCode(port.write({}))).toBe('INVALID_ARGUMENT')
    await port.close()
  })

  test('takes a snapshot: the caller may reuse its buffer at once', async () => {
    const { port, device } = await opened()
    device.setStalled(true)
    const buffer = new TextEncoder().encode('first')
    const pending = port.write(buffer)
    buffer.set(new TextEncoder().encode('XXXXX'))
    device.setStalled(false)
    await pending
    expect(decoder.decode(device.takeWritten())).toBe('first')
    await port.close()
  })

  test('a write the device never takes rejects TIMEOUT after writeTimeout', async () => {
    const { port, device } = await opened({ writeTimeout: 50 })
    device.setStalled(true)
    expect(await rejectionCode(port.write('x'))).toBe('TIMEOUT')
    device.setStalled(false)
    await port.close()
  })

  test('maxQueuedWrites: past it, write() rejects QUEUE_FULL at once', async () => {
    const { port, device } = await opened({ maxQueuedWrites: 2 })
    device.setStalled(true)
    const first = port.write('a')
    const second = port.write('b')
    expect(port.queuedWrites).toBe(2)
    expect(await rejectionCode(port.write('c'))).toBe('QUEUE_FULL')
    expect(port.queuedWrites).toBe(2)

    device.setStalled(false)
    await Promise.all([first, second])
    expect(port.queuedWrites).toBe(0)
    await port.write('d')
    expect(decoder.decode(device.takeWritten())).toBe('abd')
    await port.close()
  })

  test('a write that times out frees its place in the queue', async () => {
    const { port, device } = await opened({ maxQueuedWrites: 1, writeTimeout: 20 })
    device.setStalled(true)
    expect(await rejectionCode(port.write('a'))).toBe('TIMEOUT')
    expect(port.queuedWrites).toBe(0)
    device.setStalled(false)
    await port.write('b')
    expect(decoder.decode(device.takeWritten())).toBe('b')
    await port.close()
  })

  test('maxQueuedWrites counts writes only, and a closed port still reports NOT_OPEN', async () => {
    const { port, device } = await opened({ maxQueuedWrites: 1 })
    device.setStalled(true)
    const drain = rejectionCode(port.drain())
    const write = rejectionCode(port.write('a'))
    expect(port.queuedWrites).toBe(1)
    const closing = port.close()
    expect(await rejectionCode(port.write('b'))).toBe('NOT_OPEN')
    await closing
    expect([await drain, await write]).toEqual(['CANCELED', 'CANCELED'])
    expect(port.queuedWrites).toBe(0)
  })

  test('the queue is unbounded by default', async () => {
    const { port, device } = await opened()
    device.setStalled(true)
    const writes = Array.from({ length: 1000 }, () => port.write('x'))
    expect(port.queuedWrites).toBe(1000)
    device.setStalled(false)
    await Promise.all(writes)
    expect(device.takeWritten().length).toBe(1000)
    await port.close()
  })

  test('update() waits for the writes queued before it', async () => {
    const { port, device } = await opened()
    device.setStalled(true)
    const write = port.write('before')
    const update = port.update({ baudRate: 57600 })
    await Bun.sleep(10)
    expect(device.options?.baudRate).toBe(9600)
    device.setStalled(false)
    await Promise.all([write, update])
    expect(device.options?.baudRate).toBe(57600)
    expect(port.baudRate).toBe(57600)
    await port.close()
  })
})

describe('close', () => {
  test('emits close with no argument after a deliberate close', async () => {
    const { port } = await opened()
    const args = new Promise<unknown[]>((resolve) => port.once('close', (...received) => resolve(received)))
    await port.close()
    expect(await args).toEqual([])
    expect(port.isOpen).toBe(false)
  })

  test('isOpen turns false as soon as close() starts', async () => {
    const { port } = await opened()
    const closing = port.close()
    expect(port.isOpen).toBe(false)
    await closing
  })

  test('waits for a write that was not awaited before close()', async () => {
    const { port, device } = await opened()
    device.setWriteDelay(20)
    const write = port.write('bye')
    await port.close()
    await write
    expect(decoder.decode(device.takeWritten())).toBe('bye')
  })

  test('waits for writes made before close() while autoOpen was pending', async () => {
    const binding = new MockBinding()
    const device = binding.addPort(PATH)
    device.setWriteDelay(10)
    const port = new SerialPort({ path: PATH, baudRate: 9600, binding })
    const write = port.write('early')
    await port.close()
    await write
    expect(decoder.decode(device.takeWritten())).toBe('early')
  })

  test('rejects writes made after close() started', async () => {
    const { port } = await opened()
    const closing = port.close()
    expect(await rejectionCode(port.write('late'))).toBe('NOT_OPEN')
    await closing
  })

  test('abandons a stalled write instead of waiting on it', async () => {
    const { port, device } = await opened()
    device.setStalled(true)
    const outcome = rejectionCode(port.write('stuck'))
    await port.close()
    expect(await outcome).toBe('CANCELED')
    expect(device.isOpen).toBe(false)
  })

  test('cancels a drain stuck on the device', async () => {
    const { port, device } = await opened()
    device.setStalled(true)
    const outcome = rejectionCode(port.drain())
    await port.close()
    expect(await outcome).toBe('CANCELED')
  })

  test('close() while autoOpen is pending closes after the open', async () => {
    const binding = new MockBinding()
    const device = binding.addPort(PATH)
    const port = new SerialPort({ path: PATH, baudRate: 9600, binding })
    await port.close()
    expect(device.isOpen).toBe(false)
    expect(port.isOpen).toBe(false)
  })

  test('await using closes the port at the end of the scope', async () => {
    const binding = new MockBinding()
    const device = binding.addPort(PATH)
    {
      await using port = new SerialPort({ path: PATH, baudRate: 9600, binding })
      await port.write('scoped')
      expect(device.isOpen).toBe(true)
    }
    expect(device.isOpen).toBe(false)
  })
})

describe('disconnect', () => {
  test('emits error, then close carrying the same error', async () => {
    const { port, device } = await opened()
    const error = new Promise<SerialPortError>((resolve) => port.once('error', resolve))
    const closed = new Promise<SerialPortError | undefined>((resolve) => port.once('close', resolve))
    device.disconnect()
    const [reported, cause] = await Promise.all([error, closed])
    expect(reported.code).toBe('DISCONNECTED')
    expect(cause).toBe(reported)
    expect(port.isOpen).toBe(false)
    expect(await rejectionCode(port.write('late'))).toBe('NOT_OPEN')
  })

  test('isOpen is already false inside the error listener', async () => {
    const { port, device } = await opened()
    const seen = new Promise<boolean>((resolve) => port.once('error', () => resolve(port.isOpen)))
    device.disconnect()
    expect(await seen).toBe(false)
  })

  test('after reconnect() the port can be reopened', async () => {
    const { binding, port, device } = await opened()
    const closed = new Promise((resolve) => port.once('close', resolve))
    port.once('error', () => {})
    device.disconnect()
    await closed
    expect(await binding.list()).toEqual([])
    expect(await rejectionCode(port.open())).toBe('NOT_FOUND')

    device.reconnect()
    expect((await binding.list()).map((info) => info.path)).toEqual([PATH])
    await port.open()
    const chunk = new Promise<Uint8Array>((resolve) => port.once('data', resolve))
    device.emit('back')
    expect(decoder.decode(await chunk)).toBe('back')
    await port.write('hi')
    expect(decoder.decode(device.takeWritten())).toBe('hi')
    await port.close()
  })

  test('a mock port left open across a replug stays disconnected and does not hold the device', async () => {
    const binding = new MockBinding()
    const device = binding.addPort(PATH)
    const options = { baudRate: 9600 } as const
    const stale = await binding.open(PATH, resolveOpenOptions(options, binding.capabilities))
    device.disconnect()
    device.reconnect()
    expect(await rejectionCode(stale.write(Uint8Array.of(1)))).toBe('DISCONNECTED')

    const fresh = await binding.open(PATH, resolveOpenOptions(options, binding.capabilities))
    await stale.close()
    await fresh.write(Uint8Array.of(2))
    expect([...device.takeWritten()]).toEqual([2])
    expect(await rejectionCode(binding.open(PATH, resolveOpenOptions(options, binding.capabilities)))).toBe('BUSY')
    await fresh.close()
  })
})

describe('modem lines', () => {
  test('set() changes only the lines it names', async () => {
    const { port, device } = await opened()
    await port.set({ dtr: true })
    await port.set({ rts: true, brk: false })
    expect(device.lines).toEqual({ dtr: true, rts: true, brk: false })
    await port.close()
  })

  test('set() rejects unknown flags and non-boolean values before touching the device', async () => {
    const { port, device } = await opened()
    // @ts-expect-error unknown key
    expect(await rejectionCode(port.set({ dsr: true }))).toBe('INVALID_ARGUMENT')
    // @ts-expect-error wrong type
    expect(await rejectionCode(port.set({ dtr: 1 }))).toBe('INVALID_ARGUMENT')
    expect(device.lines.dtr).toBe(false)
    await port.close()
  })

  test('get() reports the input lines', async () => {
    const { port, device } = await opened()
    device.setStatus({ cts: true, ri: true })
    expect(await port.get()).toEqual({ cts: true, dsr: false, dcd: false, ri: true })
    await port.close()
  })
})

test('errors are SerialPortErrors with stable codes', async () => {
  const { port } = setup()
  const error = await port.write('x').catch((err: unknown) => err)
  expect(isSerialPortError(error, 'NOT_OPEN')).toBe(true)
  expect(error).toBeInstanceOf(Error)
})
