// One open tty on Linux or macOS. Ported from bun-serialport's posix.js
// (fredrikpaulin/bun-serialport, MIT): non-blocking fd, EAGAIN-aware reads and
// writes, flock for exclusive access, close-on-exec. Where bun-serialport
// polled, a read or write that would block waits for the poller (poller.ts)
// to report the fd ready; tcdrain runs on a worker thread instead of blocking
// the event loop.
//
// macOS serial drivers keep a transmit buffer of their own — about 16 KB in
// Apple's FTDI driver, 2 KB in its CDC-ACM one — that TIOCOUTQ doesn't count,
// and refill it from the tty only once it is nearly empty. A port whose line
// never stops can so refuse every byte for over a second at 115200, and its
// queue length says little about what is left to send. On macOS the port
// therefore keeps its own account of when the line can be clear of
// everything the OS accepted, and lets that time pass before a write counts
// as stalled or a drain gives up. The same drivers hold up tcflush,
// close(2), modem-line ioctls and even open(2) of the device behind a
// tcdrain in progress — forever, if flow control holds the output — so while
// one may be, none of those runs on the event loop's thread.
//
// On Linux, close(2) waits — up to 30 s by default — for output the driver
// still holds, and a tcflush doesn't always discard it: cdc_acm keeps what
// it has handed to USB until the device takes it. A close with output still
// queued therefore runs on a worker thread too.

import { realpathSync } from 'node:fs'
import { canceledError, notOpenError, SerialPortError } from '../../errors.js'
import { PortLifetime } from '../../internal/lifetime.js'
import { frameTimeMs, lineTimeBudgetMs, transmitBudgetMs } from '../../internal/timing.js'
import type { BlockingCall } from '../../internal/worker-pool.js'
import type { ResolvedOpenOptions } from '../../options.js'
import type { BindingPort, ModemLines, ModemStatus, UpdateOptions } from '../types.js'
import { drainOffThread, PortThread } from './blocking.js'
import type { PosixConstants } from './constants.js'
import { errnoError, loadLibc, type Libc } from './ffi.js'
import { acquirePoller, type Direction, type Poller } from './poller.js'
import { configureTermios, setTermios2Speed } from './termios.js'

// When the output queue can't be measured, and as headroom for what sits in
// the driver and UART FIFO beyond the kernel's queue.
const UNMEASURED_OUTPUT_BYTES = 4096
// Apple's FTDI driver reports a drain as if each character took 12 bits
// rather than 10, and the lag adds up while it stays busy: 2.3 s after
// 128 KiB at 115200.
const REPORTED_DRAIN_PACE = 1.2
// How long flush() and close() wait for a tcflush or close(2) the driver is
// holding up (macOS), or a close(2) waiting for output (Linux). A flush then
// fails, though it may still take effect later; a close finishes in the
// background.
const HELD_UP_WAIT_MS = 1000

// Devices on which a close(2) of ours — or on macOS a tcdrain — may still be
// in the kernel, with how many. Opening one is refused rather than left to
// block in open(2) behind it.
const busyDevices = new Map<string, number>()

// One key per device: /dev/tty.X and /dev/cu.X are two doors to the same one.
function deviceKey(path: string): string {
  let resolved = path
  try {
    resolved = realpathSync(path)
  } catch {}
  return resolved.replace(/^\/dev\/tty\./, '/dev/cu.')
}

export class PosixPort implements BindingPort {
  readonly #lib: Libc
  readonly #c: PosixConstants
  readonly #fd: number
  readonly #lifetime = new PortLifetime()
  // Null where the system has no poller to give: waits then poll on a timer.
  readonly #poller: Poller | null
  #options: ResolvedOpenOptions
  #drainJob: BlockingCall | null = null
  #gone: SerialPortError | null = null
  // macOS: the driver's buffer is invisible, so its output is accounted for.
  readonly #accountsOutput: boolean
  // When the line can be clear of everything accepted so far, at the
  // earliest; when bytes were last accepted; and when the driver will report
  // everything sent, by its own count.
  #lineClearAt = 0
  #lastAccepted = 0
  #drainReportedAt = 0
  // Made the first time a tcflush could be held up (macOS) or a close(2)
  // would wait for output (Linux).
  #thread: PortThread | null = null
  // This device's key in busyDevices, and how many entries are ours.
  readonly #device: string
  #busy = 0
  // macOS: a drain was abandoned, and its tcdrain may never return.
  #drainStuck = false

  static open(path: string, options: ResolvedOpenOptions, c: PosixConstants): PosixPort {
    const device = deviceKey(path)
    if (busyDevices.has(device)) {
      throw new SerialPortError('BUSY', `Cannot open ${path}: its driver is still busy with an earlier drain or close`)
    }
    const lib = loadLibc(c)
    // O_NONBLOCK keeps open() from waiting for carrier, and makes read and
    // write return EAGAIN instead of blocking. O_CLOEXEC keeps spawned children
    // from inheriting the port — and with it the lock and the DTR state.
    const fd = lib.open(path, c.O_RDWR | c.O_NOCTTY | c.O_NONBLOCK | c.O_CLOEXEC)
    if (fd < 0) {
      const errno = lib.errno()
      const gone = errno === c.errno.ENXIO || errno === c.errno.ENODEV
      throw errnoError(lib, c, 'open', errno, { path, code: gone ? 'NOT_FOUND' : undefined })
    }
    try {
      configure(lib, c, fd, path, options)
    } catch (err) {
      lib.close(fd)
      throw err
    }
    return new PosixPort(path, options, c, lib, fd, acquirePoller(lib, c), device)
  }

  private constructor(
    readonly path: string,
    options: ResolvedOpenOptions,
    c: PosixConstants,
    lib: Libc,
    fd: number,
    poller: Poller | null,
    device: string,
  ) {
    this.#options = options
    this.#c = c
    this.#lib = lib
    this.#fd = fd
    this.#poller = poller
    this.#device = device
    this.#accountsOutput = c.platform === 'darwin'
  }

  get options(): ResolvedOpenOptions {
    return this.#options
  }

  get isOpen(): boolean {
    return !this.#lifetime.closed
  }

  async read(buffer: Uint8Array, signal?: AbortSignal): Promise<number> {
    this.#assertUsable()
    const { EAGAIN, EINTR } = this.#c.errno
    for (;;) {
      const count = this.#lib.read(this.#fd, buffer)
      if (count > 0) return count
      if (count === 0) {
        throw this.#lost(new SerialPortError('DISCONNECTED', `Device disconnected: ${this.path}`, { syscall: 'read' }))
      }
      const errno = this.#lib.errno()
      if (errno === EINTR) continue
      if (errno !== EAGAIN) throw this.#lost(errnoError(this.#lib, this.#c, 'read', errno, { path: this.path }))
      await this.#ready('read', Infinity, signal)
      this.#assertUsable(true)
    }
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.#assertUsable()
    const { EAGAIN, EINTR } = this.#c.errno
    let offset = 0
    let lastProgress = performance.now()
    while (offset < data.length) {
      const count = this.#lib.write(this.#fd, offset === 0 ? data : data.subarray(offset))
      if (count > 0) {
        offset += count
        lastProgress = performance.now()
        this.#accepted(count, lastProgress)
        continue
      }
      if (count < 0) {
        const errno = this.#lib.errno()
        if (errno === EINTR) continue
        if (errno !== EAGAIN) throw errnoError(this.#lib, this.#c, 'write', errno, { path: this.path })
      }
      // The OS buffer is full. The write is stalled — the state where giving
      // up is allowed — once the OS should have room again: at once, or on
      // macOS once the output it holds is due to be out.
      const now = performance.now()
      const stalledSince = Math.max(lastProgress, this.#outputDueAt())
      const stalled = now >= stalledSince
      if (stalled) {
        if (signal?.aborted) throw canceledError()
        if (now - stalledSince >= this.#options.writeTimeout) {
          throw new SerialPortError(
            'TIMEOUT',
            `${this.path} accepted no data for ${this.#options.writeTimeout} ms`,
            { syscall: 'write' },
          )
        }
      }
      // Until then an abort only cuts the wait short, to look again.
      const early = !stalled && signal?.aborted === true
      const until = early ? stalledSince : stalledSince + this.#options.writeTimeout
      await this.#ready('write', until - now, early ? undefined : signal).catch((err: unknown) => {
        if (stalled) throw err
      })
      this.#assertUsable(true)
    }
  }

  async drain(signal?: AbortSignal): Promise<void> {
    this.#assertUsable()
    // macOS drivers hold open(2) of the device behind a tcdrain.
    const holdsOpen = this.#accountsOutput
    if (holdsOpen) this.#markBusy()
    const job = drainOffThread(this.#fd, this.#lib.path, this.#c)
    this.#drainJob = job

    // Once the caller gives up, allow the queued output time to go out, then
    // discard the rest — which wakes tcdrain, where the driver lets it — and
    // stop waiting.
    let timer: ReturnType<typeof setTimeout> | undefined
    const giveUp = () => {
      timer = setTimeout(() => {
        if (!this.#lifetime.closed) this.#discardOutput()
        job.abandon()
      }, this.#drainBudgetMs())
    }
    if (signal?.aborted) giveUp()
    else signal?.addEventListener('abort', giveUp, { once: true })

    let errno: number
    let returned = false
    try {
      errno = await job.result
      returned = true
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', giveUp)
      if (this.#drainJob === job) this.#drainJob = null
      // Abandoned, its tcdrain may still be in the kernel: the device stays
      // busy until the fd is closed.
      if (!returned) this.#drainStuck = true
      else if (holdsOpen) this.#clearBusy(1)
    }
    this.#assertUsable(true)
    if (errno !== 0) throw errnoError(this.#lib, this.#c, 'tcdrain', errno, { path: this.path })
  }

  async update(options: UpdateOptions): Promise<void> {
    this.#assertUsable()
    applySpeed(this.#lib, this.#c, this.#fd, this.path, options.baudRate)
    this.#options = Object.freeze({ ...this.#options, baudRate: options.baudRate })
  }

  async set(lines: ModemLines): Promise<void> {
    this.#assertUsable()
    if (this.#accountsOutput && (this.#drainJob || this.#drainStuck)) await this.#afterDrain()
    const c = this.#c
    let raise = 0
    let lower = 0
    if (lines.dtr !== undefined) lines.dtr ? (raise |= c.TIOCM_DTR) : (lower |= c.TIOCM_DTR)
    if (lines.rts !== undefined) lines.rts ? (raise |= c.TIOCM_RTS) : (lower |= c.TIOCM_RTS)
    if (raise) this.#ioctl('TIOCMBIS', c.TIOCMBIS, int32(raise))
    if (lower) this.#ioctl('TIOCMBIC', c.TIOCMBIC, int32(lower))
    if (lines.brk === true) this.#ioctl('TIOCSBRK', c.TIOCSBRK, null)
    if (lines.brk === false) this.#ioctl('TIOCCBRK', c.TIOCCBRK, null)
  }

  async get(): Promise<ModemStatus> {
    this.#assertUsable()
    if (this.#accountsOutput && (this.#drainJob || this.#drainStuck)) await this.#afterDrain()
    const c = this.#c
    const bits = int32(0)
    this.#ioctl('TIOCMGET', c.TIOCMGET, bits)
    const value = new DataView(bits.buffer).getInt32(0, true)
    return {
      cts: (value & c.TIOCM_CTS) !== 0,
      dsr: (value & c.TIOCM_DSR) !== 0,
      dcd: (value & c.TIOCM_CD) !== 0,
      ri: (value & c.TIOCM_RI) !== 0,
    }
  }

  async flush(): Promise<void> {
    this.#assertUsable()
    if (!this.#accountsOutput) {
      if (this.#lib.tcflush(this.#fd, this.#c.TCIOFLUSH) < 0) {
        throw errnoError(this.#lib, this.#c, 'tcflush', this.#lib.errno(), { path: this.path })
      }
      return
    }
    // The line clocks stay as they are: Apple's FTDI driver keeps sending
    // its own buffer through a flush.
    const errno = await settledWithin(this.#portThread().flush(this.#c.TCIOFLUSH), HELD_UP_WAIT_MS)
    if (errno === null) {
      throw new SerialPortError('IO', `tcflush ${this.path} did not return within ${HELD_UP_WAIT_MS} ms`, {
        syscall: 'tcflush',
      })
    }
    if (errno !== 0) throw errnoError(this.#lib, this.#c, 'tcflush', errno, { path: this.path })
  }

  async close(): Promise<void> {
    if (this.#lifetime.closed) return
    this.#lifetime.end()
    const drain = this.#drainJob
    if (drain) {
      // Wake the worker's tcdrain, where the driver lets it, before the fd goes away.
      this.#discardOutput()
      drain.abandon()
    }
    // The poller lets go of the fd before its number can be reused.
    this.#poller?.forget(this.#fd)
    // Linux: with output still queued, close(2) waits for it to go out.
    const outputHeld = !this.#accountsOutput && (this.#outputQueue() ?? 0) > 0
    if (this.#thread || outputHeld) {
      this.#markBusy()
      const closing = this.#closeOffThread()
      closing.finally(() => this.#clearBusy(this.#busy))
      await settledWithin(closing, HELD_UP_WAIT_MS)
    } else {
      // A failed close(2) has still released the fd on Linux and macOS; retrying
      // could close a descriptor some other code just opened.
      this.#lib.close(this.#fd)
      this.#clearBusy(this.#busy)
    }
    this.#poller?.release()
  }

  // Wait until the fd may be ready for `direction`, for at most `ms`, or
  // until the port closes; rejects CANCELED if `signal` aborts first.
  async #ready(direction: Direction, ms: number, signal?: AbortSignal): Promise<void> {
    if (!this.#poller) {
      await this.#lifetime.wait(Math.min(ms, this.#options.pollInterval), signal)
      return
    }
    const wait = this.#poller.wait(this.#fd, direction, this.#options.pollInterval)
    try {
      await this.#lifetime.wait(ms, signal, wait.done)
    } finally {
      wait.stop()
    }
  }

  #assertUsable(afterWait = false): void {
    if (this.#lifetime.closed) throw afterWait ? canceledError() : notOpenError(this.path)
    if (this.#gone) {
      throw new SerialPortError('DISCONNECTED', `Device disconnected: ${this.path}`, { cause: this.#gone })
    }
  }

  // Reads are where a vanished device shows up for certain (the read loop
  // never stops polling), so only they mark the port as gone for good.
  #lost(error: SerialPortError): SerialPortError {
    if (error.code === 'DISCONNECTED') this.#gone ??= error
    return error
  }

  #ioctl(name: string, request: number, arg: Uint8Array | null): void {
    if (this.#lib.ioctl(this.#fd, request, arg) < 0) {
      throw errnoError(this.#lib, this.#c, `ioctl ${name}`, this.#lib.errno(), { path: this.path })
    }
  }

  #queuedOutput(): number {
    return (this.#lifetime.closed ? null : this.#outputQueue()) ?? UNMEASURED_OUTPUT_BYTES
  }

  // TIOCOUTQ — on Linux what close(2) would wait for — or null if it fails.
  #outputQueue(): number | null {
    const count = int32(0)
    if (this.#lib.ioctl(this.#fd, this.#c.TIOCOUTQ, count) < 0) return null
    return new DataView(count.buffer).getInt32(0, true)
  }

  #accepted(count: number, now: number): void {
    const lineMs = count * frameTimeMs(this.#options)
    this.#lineClearAt = Math.max(this.#lineClearAt, now) + lineMs
    this.#drainReportedAt = Math.max(this.#drainReportedAt, now) + lineMs * REPORTED_DRAIN_PACE
    this.#lastAccepted = now
  }

  // When the OS should be done with everything accepted so far, headroom
  // included; 0 where its queue can be trusted instead (Linux).
  #outputDueAt(): number {
    if (!this.#accountsOutput) return 0
    const lineMs = this.#lineClearAt - this.#lastAccepted
    return lineMs > 0 ? this.#lastAccepted + lineTimeBudgetMs(lineMs) : 0
  }

  // How long an abandoned drain lets the queued output go on. On macOS
  // TIOCOUTQ is no use — it counts only the tty's 1 KB — and, behind a
  // tcdrain that flow control holds, never returns.
  #drainBudgetMs(): number {
    if (!this.#accountsOutput) return transmitBudgetMs(this.#options, this.#queuedOutput() + UNMEASURED_OUTPUT_BYTES)
    return Math.max(
      transmitBudgetMs(this.#options, UNMEASURED_OUTPUT_BYTES),
      lineTimeBudgetMs(this.#drainReportedAt - performance.now()),
    )
  }

  // macOS drivers hold modem-line ioctls until a tcdrain in progress
  // returns. Wait for ours here, so the event loop's thread isn't the one
  // held; one that was abandoned may never return, so then give up.
  async #afterDrain(): Promise<void> {
    const drain = this.#drainJob
    const returned = drain ? await drain.result.then(() => true, () => false) : false
    this.#assertUsable(true)
    if (!returned || this.#drainStuck) throw canceledError()
  }

  #markBusy(): void {
    this.#busy++
    busyDevices.set(this.#device, (busyDevices.get(this.#device) ?? 0) + 1)
  }

  #clearBusy(count: number): void {
    if (count <= 0) return
    this.#busy -= count
    const left = (busyDevices.get(this.#device) ?? 0) - count
    if (left > 0) busyDevices.set(this.#device, left)
    else busyDevices.delete(this.#device)
  }

  #portThread(): PortThread {
    return (this.#thread ??= new PortThread(this.#fd, this.#lib.path, this.#c))
  }

  // Behind any tcflush still held up (macOS), and with it maybe for good. A
  // worker that failed never ran it, so then it happens here.
  async #closeOffThread(): Promise<void> {
    try {
      await this.#portThread().close()
    } catch {
      this.#lib.close(this.#fd)
    }
  }

  // Before the fd is closed only. Also wakes a tcdrain waiting on the output,
  // where the driver lets it (Apple's FTDI driver holds the flush up instead).
  #discardOutput(): void {
    if (this.#accountsOutput) this.#portThread().flush(this.#c.TCOFLUSH).catch(() => {})
    else this.#lib.tcflush(this.#fd, this.#c.TCOFLUSH)
  }
}

// The call's result, or null if it hasn't returned within `ms`.
function settledWithin<T>(call: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, ms, null)
  })
  return Promise.race([call, late]).finally(() => clearTimeout(timer))
}

// Exclusive lock, raw mode and line settings, then a clean slate. Uses
// TCSANOW rather than TCSAFLUSH: the latter waits for output a previous user
// left queued, which can block indefinitely under flow control.
function configure(lib: Libc, c: PosixConstants, fd: number, path: string, options: ResolvedOpenOptions): void {
  // flock only guards against other flock users, but that covers the
  // realistic failure: two of your own processes splitting one byte stream.
  if (options.lock && lib.flock(fd, c.LOCK_EX | c.LOCK_NB) < 0) {
    const errno = lib.errno()
    if (errno === c.errno.EAGAIN) {
      throw new SerialPortError('BUSY', `Cannot lock ${path}: the port is in use by another process`, {
        syscall: 'flock',
        osCode: errno,
      })
    }
    throw errnoError(lib, c, 'flock', errno, { path })
  }

  const termios = new Uint8Array(c.termios.size)
  if (lib.tcgetattr(fd, termios) < 0) {
    const errno = lib.errno()
    // Linux says ENOTTY for a non-terminal; macOS says ENODEV for some (e.g. /dev/null).
    if (errno === c.errno.ENOTTY || errno === c.errno.ENODEV) {
      throw new SerialPortError('INVALID_ARGUMENT', `${path} is not a serial port`, { syscall: 'tcgetattr', osCode: errno })
    }
    throw errnoError(lib, c, 'tcgetattr', errno, { path })
  }
  configureTermios(termios, options, c)

  // Rates outside the classic table go on afterwards, from a 9600 placeholder.
  const speed = c.speeds.get(options.baudRate)
  setSpeedFields(lib, c, termios, path, speed ?? (c.speeds.get(9600) as number))
  if (lib.tcsetattr(fd, c.TCSANOW, termios) < 0) {
    throw errnoError(lib, c, 'tcsetattr', lib.errno(), { path })
  }
  if (speed === undefined) setCustomSpeed(lib, c, fd, path, options.baudRate)
  lib.tcflush(fd, c.TCIOFLUSH)
}

function applySpeed(lib: Libc, c: PosixConstants, fd: number, path: string, baudRate: number): void {
  const speed = c.speeds.get(baudRate)
  if (speed === undefined) {
    setCustomSpeed(lib, c, fd, path, baudRate)
    return
  }
  const termios = new Uint8Array(c.termios.size)
  if (lib.tcgetattr(fd, termios) < 0) throw errnoError(lib, c, 'tcgetattr', lib.errno(), { path })
  setSpeedFields(lib, c, termios, path, speed)
  if (lib.tcsetattr(fd, c.TCSANOW, termios) < 0) throw errnoError(lib, c, 'tcsetattr', lib.errno(), { path })
}

function setSpeedFields(lib: Libc, c: PosixConstants, termios: Uint8Array, path: string, speed: number): void {
  if (lib.cfsetispeed(termios, speed) < 0 || lib.cfsetospeed(termios, speed) < 0) {
    throw errnoError(lib, c, 'cfsetspeed', lib.errno(), { path })
  }
}

// Linux: struct termios2 + BOTHER through raw ioctls, bypassing libc. macOS:
// IOSSIOSPEED, which hands the driver the literal rate.
function setCustomSpeed(lib: Libc, c: PosixConstants, fd: number, path: string, baudRate: number): void {
  const refused = (syscall: string) => {
    const errno = lib.errno()
    const unsupported = errno === c.errno.EINVAL || errno === c.errno.ENOTTY
    return unsupported
      ? new SerialPortError('UNSUPPORTED', `${path} does not support ${baudRate} baud`, { syscall, osCode: errno })
      : errnoError(lib, c, syscall, errno, { path })
  }
  if (c.termios2) {
    const termios2 = new Uint8Array(c.termios2.size)
    if (lib.ioctl(fd, c.termios2.TCGETS2, termios2) < 0) throw refused('ioctl TCGETS2')
    setTermios2Speed(termios2, baudRate, c)
    if (lib.ioctl(fd, c.termios2.TCSETS2, termios2) < 0) throw refused('ioctl TCSETS2')
  } else if (c.IOSSIOSPEED !== undefined) {
    const speed = new Uint8Array(8)
    new DataView(speed.buffer).setBigUint64(0, BigInt(baudRate), true)
    if (lib.ioctl(fd, c.IOSSIOSPEED, speed) < 0) throw refused('ioctl IOSSIOSPEED')
  } else {
    throw new SerialPortError('UNSUPPORTED', `${baudRate} baud is not supported on this platform`)
  }
}

function int32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setInt32(0, value, true)
  return bytes
}
