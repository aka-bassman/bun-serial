// Open options: public types, defaults, and the single place they're validated.
// Bindings receive ResolvedOpenOptions and can trust every field, so validation
// is never duplicated per platform.

import { invalidArgument, SerialPortError } from './errors.js'
import type { Binding, BindingCapabilities } from './bindings/types.js'
import type { SerialPortEvents } from './serial-port.js'

export type DataBits = 5 | 6 | 7 | 8
export type StopBits = 1 | 1.5 | 2
export type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space'

export interface OpenOptions {
  /** Any positive integer. Rates outside the classic table need a binding with customBaudRates. */
  baudRate: number
  /** @default 8 */
  dataBits?: DataBits
  /** @default 1 */
  stopBits?: StopBits
  /**
   * On Linux and macOS, bytes failing the parity check are dropped; Windows
   * has no such setting and delivers them. @default 'none'
   */
  parity?: Parity
  /** Hardware flow control (RTS/CTS). @default false */
  rtscts?: boolean
  /** Software flow control: honor XON/XOFF sent by the device. @default false */
  xon?: boolean
  /** Software flow control: send XON/XOFF to the device. @default false */
  xoff?: boolean
  /** Any received byte resumes XOFF-stopped output. @default false */
  xany?: boolean
  /**
   * Drop DTR/RTS on close. Pass false for boards that reset on a DTR edge
   * (most Arduino/ESP dev boards). On Windows, where drivers drop DTR on close
   * regardless, false keeps DTR and RTS deasserted from open instead.
   * @default true
   */
  hupcl?: boolean
  /** Exclusive access. false allows sharing where the OS permits it. @default true */
  lock?: boolean
  /**
   * How often to check the OS where it can't say when a port is ready, in
   * ms: drain() on Windows, drivers that ignore the read timeouts there, and
   * systems where no poller can be had. Reads and writes otherwise wait for
   * the OS to report the port ready. @default 1
   */
  pollInterval?: number
  /**
   * How long a write may stall before it rejects with TIMEOUT, in ms: the OS
   * takes no bytes although it should have room by now. On macOS that is once
   * the output it already took should have gone out at this baud rate, since
   * its drivers can refuse bytes for that long while still sending. Infinity
   * waits forever — useful when hardware flow control can legitimately hold
   * output for a long time.
   * @default 1000
   */
  writeTimeout?: number
}

export interface SerialPortOptions extends OpenOptions {
  /** /dev/ttyUSB0, /dev/cu.usbserial-110, COM3, ... */
  path: string
  /** Open from the constructor, on the next microtask. @default true */
  autoOpen?: boolean
  /** Size of the buffer each read fills, in bytes. @default 65536 */
  readBufferSize?: number
  /** Use this binding instead of the platform default — e.g. MockBinding in tests. */
  binding?: Binding
  /**
   * Most write() calls pending at once — queued or in progress. Past it,
   * write() rejects QUEUE_FULL at once instead of queueing behind output the
   * device isn't taking, where each would wait out writeTimeout in turn.
   * @default Infinity
   */
  maxQueuedWrites?: number
  /**
   * Receives exceptions thrown by event listeners — including those of piped
   * parsers. Without it, each is rethrown as an uncaught exception. Either
   * way the other listeners still run and the port keeps reading.
   */
  onListenerError?: (error: unknown, event: keyof SerialPortEvents) => void
}

export type ResolvedOpenOptions = Readonly<Required<OpenOptions>>

/** The classic termios Bxxx table. Other rates need BindingCapabilities.customBaudRates. */
export const STANDARD_BAUD_RATES: ReadonlySet<number> = new Set([
  50, 75, 110, 134, 150, 200, 300, 600, 1200, 1800, 2400, 4800, 9600, 19200, 38400,
  57600, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000,
  2000000, 2500000, 3000000, 3500000, 4000000,
])

const DATA_BITS: readonly DataBits[] = [5, 6, 7, 8]
const STOP_BITS: readonly StopBits[] = [1, 1.5, 2]
const PARITIES: readonly Parity[] = ['none', 'even', 'odd', 'mark', 'space']
const FLAGS = ['rtscts', 'xon', 'xoff', 'xany', 'hupcl', 'lock'] as const

export function resolveOpenOptions(
  options: OpenOptions,
  capabilities: BindingCapabilities,
): ResolvedOpenOptions {
  const resolved = {
    baudRate: options.baudRate,
    dataBits: options.dataBits ?? 8,
    stopBits: options.stopBits ?? 1,
    parity: options.parity ?? 'none',
    rtscts: options.rtscts ?? false,
    xon: options.xon ?? false,
    xoff: options.xoff ?? false,
    xany: options.xany ?? false,
    hupcl: options.hupcl ?? true,
    lock: options.lock ?? true,
    pollInterval: options.pollInterval ?? 1,
    writeTimeout: options.writeTimeout ?? 1000,
  } satisfies Required<OpenOptions>

  // Shape: values no binding could accept. JS callers bypass the types, so
  // this has to happen at runtime.
  validateBaudRate(resolved.baudRate, capabilities)
  if (!DATA_BITS.includes(resolved.dataBits)) throw invalidArgument('dataBits', resolved.dataBits)
  if (!STOP_BITS.includes(resolved.stopBits)) throw invalidArgument('stopBits', resolved.stopBits)
  if (!PARITIES.includes(resolved.parity)) throw invalidArgument('parity', resolved.parity)
  for (const flag of FLAGS) {
    if (typeof resolved[flag] !== 'boolean') throw invalidArgument(flag, resolved[flag])
  }
  if (!Number.isFinite(resolved.pollInterval) || resolved.pollInterval < 1) {
    throw invalidArgument('pollInterval', resolved.pollInterval)
  }
  if (typeof resolved.writeTimeout !== 'number' || !(resolved.writeTimeout >= 0)) {
    throw invalidArgument('writeTimeout', resolved.writeTimeout)
  }

  // Platform: valid values this binding can't honor. Failing loudly beats a
  // silent no-op — that's how missing features stay invisible.
  if (!capabilities.dataBits.includes(resolved.dataBits)) unsupported('dataBits', resolved.dataBits)
  if (!capabilities.stopBits.includes(resolved.stopBits)) unsupported('stopBits', resolved.stopBits)
  if (!capabilities.parity.includes(resolved.parity)) unsupported('parity', resolved.parity)
  if (resolved.xany && !capabilities.xany) unsupported('xany', true)
  if (!resolved.lock && !capabilities.sharedAccess) unsupported('lock', false)

  return Object.freeze(resolved)
}

/** Shape and capability check for a baud rate, shared by open and update(). */
export function validateBaudRate(baudRate: unknown, capabilities: BindingCapabilities): number {
  if (typeof baudRate !== 'number' || !Number.isInteger(baudRate) || baudRate <= 0) {
    throw invalidArgument('baudRate', baudRate)
  }
  if (!capabilities.customBaudRates && !STANDARD_BAUD_RATES.has(baudRate)) unsupported('baudRate', baudRate)
  return baudRate
}

function unsupported(name: string, value: unknown): never {
  throw new SerialPortError('UNSUPPORTED', `${name}: ${String(value)} is not supported on this platform`)
}
