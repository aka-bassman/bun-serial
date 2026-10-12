// SerialPort on real kernel ttys: a pty pair stands in for the device.
// Runs on Linux and macOS.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadLibc, type Libc } from '../src/bindings/posix/ffi.js'
import { isSerialPortError, type SerialErrorCode } from '../src/errors.js'
import { SerialPort } from '../src/serial-port.js'
import { constants, isPosix, openPty, readIflag } from './helpers/pty.js'

const isLinux = process.platform === 'linux'
const decoder = new TextDecoder()

async function rejectionCode(promise: Promise<unknown>): Promise<SerialErrorCode | 'resolved'> {
  try {
    await promise
    return 'resolved'
  } catch (err) {
    if (isSerialPortError(err)) return err.code
    throw err
  }
}

async function openPair(options: { baudRate?: number; lock?: boolean } = {}) {
  const pty = openPty()
  const port = new SerialPort({ path: pty.slavePath, baudRate: 115200, autoOpen: false, ...options })
  await port.open()
  return { pty, port }
}

// Count the port's read() or write() calls while `run` runs.
async function counting(call: 'read' | 'write', run: (calls: () => number) => Promise<void>): Promise<void> {
  const libc = loadLibc(constants)
  const original: Libc['read'] = libc[call]
  let calls = 0
  libc[call] = (fd, buffer) => {
    calls++
    return original(fd, buffer)
  }
  try {
    await run(() => calls)
  } finally {
    libc[call] = original
  }
}

describe.if(isPosix)('posix binding on a pty', () => {
  test('ioctl receives its pointer argument (variadic ABI)', async () => {
    // FIONREAD: _IOR('f', 127, int) on macOS, 0x541B on Linux.
    const FIONREAD = isLinux ? 0x541b : 0x4004667f
    const pty = openPty()
    const libc = loadLibc(constants)
    const fd = libc.open(pty.slavePath, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK)
    try {
      pty.writeMaster('hello world\n')
      const count = new Uint8Array(4)
      const available = () => {
        new DataView(count.buffer).setInt32(0, -7, true)
        expect(libc.ioctl(fd, FIONREAD, count)).toBe(0)
        return new DataView(count.buffer).getInt32(0, true)
      }
      // Linux hands master writes to the slave's line discipline from a workqueue.
      const deadline = Date.now() + 1000
      while (available() !== 12 && Date.now() < deadline) await Bun.sleep(2)
      expect(available()).toBe(12)
    } finally {
      libc.close(fd)
      pty.closeMaster()
    }
  })

  test('open, write, close delivers every byte', async () => {
    const { pty, port } = await openPair()
    // Read concurrently, like a device would: macOS ptys hold output until the master reads.
    const received = pty.collect(8)
    await port.write('foo bar\n')
    await port.close()
    expect(decoder.decode(await received)).toBe('foo bar\n')
    pty.closeMaster()
  })

  test('a write that close() follows without an await is still delivered', async () => {
    // bun-serialport lost this write and then wrote to the closed fd.
    for (let i = 0; i < 5; i++) {
      const { pty, port } = await openPair()
      const received = pty.collect(3, 2000)
      const write = port.write('bye')
      await port.close()
      await write
      expect(decoder.decode(await received)).toBe('bye')
      pty.closeMaster()
    }
  })

  test('an idle port waits for data without polling', () =>
    counting('read', async (reads) => {
      const { pty, port } = await openPair()
      await Bun.sleep(50)
      const before = reads()
      await Bun.sleep(300)
      expect(reads() - before).toBe(0) // the last read said EAGAIN, and the port waits
      const chunk = new Promise<Uint8Array>((resolve) => port.once('data', resolve))
      pty.writeMaster('ping')
      expect(decoder.decode(await chunk)).toBe('ping')
      await port.close()
      pty.closeMaster()
    }))

  test('a write waits for room without retrying, and goes on once there is some', () =>
    counting('write', async (writes) => {
      const { pty, port } = await openPair()
      const payload = new Uint8Array(65536).fill(0x5a)
      // Nobody reads the master yet, so the pty fills and the write stalls.
      const pending = port.write(payload)
      await Bun.sleep(100)
      const before = writes()
      await Bun.sleep(300)
      expect(writes() - before).toBe(0)
      const received = pty.collect(payload.length, 10000)
      await pending
      expect((await received).length).toBe(payload.length)
      await port.close()
      pty.closeMaster()
    }))

  test('an open port keeps the process alive, and closing it lets the process exit', async () => {
    const script = `
      import { SerialPort } from ${JSON.stringify(join(import.meta.dir, '../src/index.ts'))}
      import { openPty } from ${JSON.stringify(join(import.meta.dir, 'helpers/pty.ts'))}
      const pty = openPty()
      const port = new SerialPort({ path: pty.slavePath, baudRate: 115200 })
      port.on('data', async (chunk) => {
        console.log(new TextDecoder().decode(chunk))
        await port.close()
        pty.closeMaster()
      })
      // Doesn't hold the process open by itself: only the port can.
      port.on('open', () => setTimeout(() => pty.writeMaster('late'), 300).unref())
    `
    const started = performance.now()
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(output.trim()).toBe('late')
    expect(code).toBe(0)
    expect(performance.now() - started).toBeGreaterThanOrEqual(280)
  })

  test('incoming bytes arrive as data events', async () => {
    const { pty, port } = await openPair()
    const chunk = new Promise<Uint8Array>((resolve) => port.once('data', resolve))
    pty.writeMaster('pong\n')
    expect(decoder.decode(await chunk)).toBe('pong\n')
    await port.close()
    pty.closeMaster()
  })

  test('concurrent writes do not interleave', async () => {
    const { pty, port } = await openPair()
    // Big enough to force partial writes while the master drains slowly.
    const a = new Uint8Array(32768).fill(0x41)
    const b = new Uint8Array(32768).fill(0x42)
    const writes = Promise.all([port.write(a), port.write(b)])
    const received = await pty.collect(a.length + b.length, 10000)
    await writes
    await port.close()
    pty.closeMaster()

    expect(received.length).toBe(a.length + b.length)
    expect(received.indexOf(0x42)).toBe(a.length)
    expect(received.lastIndexOf(0x41)).toBe(a.length - 1)
  })

  test('close() abandons a write stuck on a full buffer, promptly', async () => {
    const { pty, port } = await openPair()
    // Nobody reads the master, so the pty fills and the write stalls.
    const pending = port.write(new Uint8Array(1 << 20))
    const outcome = rejectionCode(pending)
    await Bun.sleep(50)

    const started = performance.now()
    await port.close()
    expect(performance.now() - started).toBeLessThan(1000)
    expect(await outcome).toBe('CANCELED')
    expect(port.isOpen).toBe(false)
    pty.closeMaster()
  })

  test('a stalled write times out after writeTimeout', async () => {
    const pty = openPty()
    const port = new SerialPort({ path: pty.slavePath, baudRate: 115200, autoOpen: false, writeTimeout: 100 })
    await port.open()
    expect(await rejectionCode(port.write(new Uint8Array(1 << 20)))).toBe('TIMEOUT')
    await port.close()
    pty.closeMaster()
  })

  test('on macOS a write stalls only once the output the OS took should be out', async () => {
    const pty = openPty()
    const port = new SerialPort({ path: pty.slavePath, baudRate: 9600, autoOpen: false, writeTimeout: 100 })
    await port.open()
    const started = performance.now()
    expect(await rejectionCode(port.write(new Uint8Array(1 << 20)))).toBe('TIMEOUT')
    const elapsed = performance.now() - started
    // A macOS pty takes 1 KiB, over a second of line at 9600 baud: its serial
    // drivers can refuse bytes for that long while still sending. Linux's
    // queue length is accurate, so there the clock starts at once.
    if (isLinux) expect(elapsed).toBeLessThan(1000)
    else expect(elapsed).toBeGreaterThan(1500)
    await pty.collect(1 << 20, 200) // so close() needn't wait for the drain to give up
    await port.close()
    pty.closeMaster()
  })

  test('write after close rejects NOT_OPEN', async () => {
    const { pty, port } = await openPair()
    await port.close()
    expect(await rejectionCode(port.write('late'))).toBe('NOT_OPEN')
    pty.closeMaster()
  })

  test('drain waits for queued output without blocking the event loop', async () => {
    const { pty, port } = await openPair()
    await port.write(new Uint8Array(1024).fill(0x58))
    let ticks = 0
    const ticker = setInterval(() => ticks++, 5)
    let drained = false
    const drain = port.drain().then(() => {
      drained = true
    })
    await Bun.sleep(100)
    // macOS holds pty output until the master reads it; Linux hands it over at once.
    if (!isLinux) expect(drained).toBe(false)
    expect(ticks).toBeGreaterThan(5)
    expect((await pty.collect(1024)).length).toBe(1024)
    await drain
    clearInterval(ticker)
    expect(drained).toBe(true)
    await port.close()
    pty.closeMaster()
  })

  test('drain waits for writes still queued behind each other', async () => {
    const { pty, port } = await openPair()
    const payload = new Uint8Array(16384).fill(0x58)
    const reader = pty.collect(payload.length, 10000)
    void port.write(payload)
    await port.drain()
    expect((await reader).length).toBe(payload.length)
    await port.close()
    pty.closeMaster()
  })

  test('close() gives up on output the device never takes', async () => {
    const { pty, port } = await openPair({ baudRate: 230400 })
    // Fill the pty without reading; nothing will ever drain it.
    await port.write(new Uint8Array(512).fill(0x41))
    const started = performance.now()
    await port.close()
    // The budget for a stuck drain is the time the queue should have taken, plus margin.
    expect(performance.now() - started).toBeLessThan(3000)
    pty.closeMaster()
  })

  test('the port survives a storm of child-process signals', async () => {
    const { pty, port } = await openPair()
    let error: unknown = null
    port.on('error', (err) => {
      error = err
    })
    for (let i = 0; i < 30; i++) {
      Bun.spawn(['true'])
      await Bun.sleep(5)
    }
    await Bun.sleep(100)
    expect(error).toBe(null)
    expect(port.isOpen).toBe(true)
    await port.close()
    pty.closeMaster()
  })

  test('a second open of a locked port fails fast with BUSY', async () => {
    const pty = openPty()
    const a = new SerialPort({ path: pty.slavePath, baudRate: 9600, autoOpen: false })
    const b = new SerialPort({ path: pty.slavePath, baudRate: 9600, autoOpen: false })
    await a.open()
    expect(await rejectionCode(b.open())).toBe('BUSY')
    await a.close()
    await b.open() // the lock dies with the fd
    await b.close()
    pty.closeMaster()
  })

  test('lock: false allows a shared open', async () => {
    const pty = openPty()
    const a = new SerialPort({ path: pty.slavePath, baudRate: 9600, lock: false, autoOpen: false })
    const b = new SerialPort({ path: pty.slavePath, baudRate: 9600, lock: false, autoOpen: false })
    await a.open()
    await b.open()
    await a.close()
    await b.close()
    pty.closeMaster()
  })

  test.if(isLinux)('spawned children do not inherit the port fd', async () => {
    const { readdir, readlink } = await import('node:fs/promises')
    const { pty, port } = await openPair()
    const child = Bun.spawn(['sleep', '2'])
    await Bun.sleep(100)
    const fds = await readdir(`/proc/${child.pid}/fd`)
    const targets = await Promise.all(fds.map((fd) => readlink(`/proc/${child.pid}/fd/${fd}`).catch(() => '')))
    child.kill()
    await port.close()
    pty.closeMaster()
    expect(targets).not.toContain(pty.slavePath)
    expect(targets).not.toContain('anon_inode:[eventpoll]') // nor the poller's
  })

  test('iflag carries IGNPAR, INPCK with parity, and IXANY when asked', async () => {
    const pty = openPty()
    const port = new SerialPort({ path: pty.slavePath, baudRate: 9600, parity: 'even', xany: true, autoOpen: false })
    await port.open()
    const iflag = readIflag(pty.slavePath)
    expect(iflag & constants.IGNPAR).toBe(constants.IGNPAR)
    expect(iflag & constants.INPCK).toBe(constants.INPCK)
    expect(iflag & constants.IXANY).toBe(constants.IXANY)
    await port.close()
    pty.closeMaster()
  })

  test('a vanished device emits error, then close carrying the same error', async () => {
    const { pty, port } = await openPair()
    const error = new Promise<unknown>((resolve) => port.once('error', resolve))
    const closed = new Promise<unknown>((resolve) => port.once('close', resolve))
    pty.closeMaster()
    const [reported, cause] = await Promise.all([error, closed])
    expect(isSerialPortError(reported, 'DISCONNECTED')).toBe(true)
    expect(cause).toBe(reported)
    expect(port.isOpen).toBe(false)
  })

  test('a deliberate close emits close without an argument', async () => {
    const { pty, port } = await openPair()
    const args = new Promise<unknown[]>((resolve) => port.once('close', (...received) => resolve(received)))
    await port.close()
    expect(await args).toEqual([])
    pty.closeMaster()
  })

  test('update() switches between standard rates and keeps moving bytes', async () => {
    const { pty, port } = await openPair({ baudRate: 9600 })
    await port.update({ baudRate: 115200 })
    expect(port.baudRate).toBe(115200)
    await port.write('ok')
    expect(decoder.decode(await pty.collect(2))).toBe('ok')
    await port.close()
    pty.closeMaster()
  })

  test.if(isLinux)('custom baud rates go through termios2', async () => {
    const { pty, port } = await openPair({ baudRate: 250000 })
    expect(port.baudRate).toBe(250000)
    await port.write('dmx\n')
    expect(decoder.decode(await pty.collect(4))).toBe('dmx\n')
    await port.update({ baudRate: 74880 }) // custom → custom
    await port.update({ baudRate: 9600 }) // custom → standard
    await port.write('ok')
    await pty.collect(2)
    await port.close()
    pty.closeMaster()
  })

  test('opening a path that is not a tty is rejected', async () => {
    const port = new SerialPort({ path: '/dev/null', baudRate: 9600, autoOpen: false })
    expect(await rejectionCode(port.open())).toBe('INVALID_ARGUMENT')
  })

  test('opening a missing path is NOT_FOUND', async () => {
    const port = new SerialPort({ path: '/dev/does-not-exist-bun-serial', baudRate: 9600, autoOpen: false })
    expect(await rejectionCode(port.open())).toBe('NOT_FOUND')
  })

  test('flush and modem-line calls reach the tty', async () => {
    const { pty, port } = await openPair()
    await port.flush()
    // ptys have no modem lines: the kernel refuses, and that surfaces as UNSUPPORTED.
    expect(['resolved', 'UNSUPPORTED']).toContain(await rejectionCode(port.get()))
    expect(['resolved', 'UNSUPPORTED']).toContain(await rejectionCode(port.set({ dtr: true })))
    await port.close()
    pty.closeMaster()
  })

  test('on macOS modem-line calls wait for a drain in progress, off the event loop', async () => {
    const { pty, port } = await openPair()
    await port.write(new Uint8Array(512).fill(0x41))
    // macOS holds pty output until the master reads it, so the drain waits.
    const drain = port.drain()
    let ticks = 0
    const ticker = setInterval(() => ticks++, 5)
    let lineSet = false
    const setting = rejectionCode(port.set({ dtr: true })).then((outcome) => {
      lineSet = true
      return outcome
    })
    await Bun.sleep(150)
    // Its drivers would hold the ioctl until tcdrain returns; on Linux nothing waits.
    expect(lineSet).toBe(isLinux)
    expect(ticks).toBeGreaterThan(10)
    await pty.collect(512)
    await drain
    expect(['resolved', 'UNSUPPORTED']).toContain(await setting)
    clearInterval(ticker)
    await port.close()
    pty.closeMaster()
  })

  test('on macOS the device cannot be opened again while a drain of ours is in the driver', async () => {
    const { pty, port } = await openPair({ lock: false })
    await port.write(new Uint8Array(512).fill(0x41))
    const drain = port.drain()
    await Bun.sleep(50)
    // Its drivers would hold open(2) up behind the tcdrain, on this thread.
    const second = new SerialPort({ path: pty.slavePath, baudRate: 115200, autoOpen: false, lock: false })
    expect(await rejectionCode(second.open())).toBe(isLinux ? 'resolved' : 'BUSY')
    if (second.isOpen) await second.close()
    await pty.collect(512)
    await drain
    expect(await rejectionCode(second.open())).toBe('resolved')
    await second.close()
    await port.close()
    pty.closeMaster()
  })

  test('flush() during a drain in progress discards the output and ends the drain', async () => {
    const { pty, port } = await openPair()
    await port.write(new Uint8Array(512).fill(0x41))
    const drain = port.drain()
    await Bun.sleep(50)
    const started = performance.now()
    await port.flush()
    await drain
    expect(performance.now() - started).toBeLessThan(1000)
    await Bun.sleep(50)
    // Linux hands pty output to the master at once, leaving nothing to discard.
    if (!isLinux) expect(pty.readMaster().length).toBeLessThan(512)
    await port.close()
    pty.closeMaster()
  })
})
