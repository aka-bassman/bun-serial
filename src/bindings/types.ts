// The contract between the platform-neutral core (SerialPort, list) and a
// platform binding (posix, win32, mock).
//
// Ground rules for implementations:
// - Inputs are already validated. open() receives options that passed
//   resolveOpenOptions() against this binding's capabilities, and the core
//   checks set()/update() arguments. Don't re-validate shape here.
// - Fail with SerialPortError using the normalized codes; put the raw errno or
//   Win32 error in osCode.
// - Don't block the event loop waiting on the device. One non-blocking syscall
//   is fine; waiting for the device to accept, deliver or transmit bytes must
//   yield (poll + sleep, overlapped I/O, or a worker).
// - The OS handle (fd or HANDLE) never leaves the binding, and is never touched
//   again once close() has been called.

import type { DataBits, Parity, ResolvedOpenOptions, StopBits } from '../options.js'

/** What a binding can honor. resolveOpenOptions() rejects anything outside it as UNSUPPORTED. */
export interface BindingCapabilities {
  readonly dataBits: readonly DataBits[]
  readonly stopBits: readonly StopBits[]
  readonly parity: readonly Parity[]
  /** Rates outside STANDARD_BAUD_RATES can be set (the driver may still refuse one at open). */
  readonly customBaudRates: boolean
  readonly xany: boolean
  /** `lock: false` can be honored. Windows always opens COM ports exclusively. */
  readonly sharedAccess: boolean
}

export interface PortInfo {
  /** What to pass as `path`: /dev/ttyUSB0, /dev/cu.usbserial-110, COM3. */
  path: string
  manufacturer?: string
  serialNumber?: string
  /** Lowercase 4-digit hex, e.g. "10c4". */
  vendorId?: string
  productId?: string
  product?: string
  /** Identity that survives replugs: by-id name (Linux), device instance ID (Windows). */
  pnpId?: string
  /** Physical port position: USB devpath (Linux), locationID (macOS), location info (Windows). */
  locationId?: string
}

/** Output lines to change; omitted keys are left as they are. */
export interface ModemLines {
  dtr?: boolean
  rts?: boolean
  /** Assert (true) or clear (false) the break condition. */
  brk?: boolean
}

export interface ModemStatus {
  cts: boolean
  dsr: boolean
  dcd: boolean
  ri: boolean
}

export interface UpdateOptions {
  baudRate: number
}

export interface Binding {
  /** For diagnostics: 'posix-linux', 'posix-darwin', 'win32', 'mock'. */
  readonly name: string
  readonly capabilities: BindingCapabilities
  list(): Promise<PortInfo[]>
  /**
   * Open and configure the port, discarding bytes buffered before open.
   * Rejects NOT_FOUND, ACCESS_DENIED, BUSY (held elsewhere and options.lock;
   * also while a close of ours — on macOS also a drain — may still be in the
   * driver),
   * UNSUPPORTED (the device refused the settings), or IO.
   */
  open(path: string, options: ResolvedOpenOptions): Promise<BindingPort>
}

/**
 * One open port. The core guarantees, so implementations can rely on it:
 * - write(), drain() and update() are serialized: at most one in flight
 * - at most one read() in flight; it may be pending during any other call
 * - set(), get() and flush() may overlap a pending write/drain/update
 * - close() is called once, after write/drain/update have settled
 * - read() buffers are never empty, write() data never is either
 *
 * After a disconnect, every call except close() rejects DISCONNECTED.
 */
export interface BindingPort {
  readonly path: string
  /** Options currently in effect (reflects update()). */
  readonly options: ResolvedOpenOptions
  /** False once close() has been called. */
  readonly isOpen: boolean

  /**
   * Wait for incoming bytes and copy them into `buffer`. Resolves with the
   * count, always ≥ 1: "no data yet" is waited out, never returned.
   * Rejects CANCELED on close() or abort, DISCONNECTED when the device is gone.
   */
  read(buffer: Uint8Array, signal?: AbortSignal): Promise<number>

  /**
   * Resolves once the OS has accepted every byte — not once they're on the
   * wire (that's drain()). Rejects TIMEOUT once the write has been stalled for
   * options.writeTimeout ms.
   *
   * `signal` is honored only while the write is stalled — waiting for the OS
   * to take more bytes when it should have room. A write that is making
   * progress completes. Where progress can't be observed mid-write (Windows),
   * a write counts as stalled once it has been pending longer than its
   * transmission time at the configured baud rate; where the OS refuses bytes
   * while still sending ones it took (macOS drivers refill their own buffer
   * only once it is nearly empty), once those should have been sent.
   */
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>

  /**
   * Resolves once every accepted byte has been transmitted. Without a signal
   * this waits as long as it takes (forever, if flow control never releases).
   * Once `signal` is aborted, the binding stops waiting when the queued output
   * should have finished transmitting (plus a margin), discards what's left,
   * and rejects CANCELED.
   */
  drain(signal?: AbortSignal): Promise<void>

  /** Apply immediately (TCSANOW). The core drains before calling it. */
  update(options: UpdateOptions): Promise<void>
  set(lines: ModemLines): Promise<void>
  get(): Promise<ModemStatus>
  /** Discard unread input and untransmitted output. */
  flush(): Promise<void>

  /**
   * Release the OS handle; a pending read rejects CANCELED. Never rejects.
   * A close(2) that the driver holds up (macOS), or that waits for output
   * still queued (Linux), finishes in the background.
   */
  close(): Promise<void>
}
