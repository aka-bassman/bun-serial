// In-memory binding for tests: no hardware, no FFI, runs on every OS. Register
// a path with addPort() and drive the returned MockDevice as the far end of the
// cable. Also serves as the reference implementation of the BindingPort contract.

import { canceledError, SerialPortError } from '../../errors.js'
import { concatBytes } from '../../internal/bytes.js'
import type { ResolvedOpenOptions } from '../../options.js'
import type {
  Binding,
  BindingCapabilities,
  BindingPort,
  ModemLines,
  ModemStatus,
  PortInfo,
  UpdateOptions,
} from '../types.js'

const textEncoder = new TextEncoder()

const mockCapabilities: BindingCapabilities = {
  dataBits: [5, 6, 7, 8],
  stopBits: [1, 1.5, 2],
  parity: ['none', 'even', 'odd', 'mark', 'space'],
  customBaudRates: true,
  xany: true,
  sharedAccess: true,
}

// State shared between a MockDevice (test side) and the port that has it open.
class DeviceState {
  inbound: Uint8Array = new Uint8Array(0)
  outbound: Uint8Array[] = []
  stalled = false
  writeDelayMs = 0
  connected = true
  /** Bumped by each reconnect(), so ports opened before it stay disconnected. */
  plugs = 0
  openPort: MockBindingPort | null = null
  lines: Required<ModemLines> = { dtr: false, rts: false, brk: false }
  status: ModemStatus = { cts: false, dsr: false, dcd: false, ri: false }
  readonly #waiters = new Set<() => void>()

  constructor(readonly info: PortInfo) {}

  notify(): void {
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const wake of waiters) wake()
  }

  // Resolves on the next notify() or after `timeoutMs`; rejects CANCELED if
  // `signal` aborts first.
  changed(signal?: AbortSignal, timeoutMs = Infinity): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(canceledError())
        return
      }
      const finish = () => {
        clearTimeout(timer)
        this.#waiters.delete(wake)
        signal?.removeEventListener('abort', onAbort)
      }
      const wake = () => {
        finish()
        resolve()
      }
      const onAbort = () => {
        finish()
        reject(canceledError())
      }
      const timer = Number.isFinite(timeoutMs) ? setTimeout(wake, timeoutMs) : undefined
      this.#waiters.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

// Lets the binding reach a device's state without making it public API.
let stateOf!: (device: MockDevice) => DeviceState

/** The far end of a mock port, driven by the test. */
export class MockDevice {
  readonly #state: DeviceState

  static {
    stateOf = (device) => device.#state
  }

  constructor(info: PortInfo) {
    this.#state = new DeviceState(info)
  }

  get info(): PortInfo {
    return { ...this.#state.info }
  }

  /** Output lines as last set by the port. */
  get lines(): Readonly<Required<ModemLines>> {
    return { ...this.#state.lines }
  }

  get isOpen(): boolean {
    return this.#state.openPort !== null
  }

  /** Options the port was opened with (reflecting update()), or null when closed. */
  get options(): ResolvedOpenOptions | null {
    return this.#state.openPort?.options ?? null
  }

  /** Send bytes to the port, as the device would. */
  emit(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? textEncoder.encode(data) : data
    this.#state.inbound = concatBytes([this.#state.inbound, bytes])
    this.#state.notify()
  }

  /** Everything the port has written since the last call. */
  takeWritten(): Uint8Array {
    const bytes = concatBytes(this.#state.outbound)
    this.#state.outbound = []
    return bytes
  }

  /** Stop (true) or resume (false) taking output, like a full OS buffer or held flow control. */
  setStalled(stalled: boolean): void {
    this.#state.stalled = stalled
    this.#state.notify()
  }

  /** Take `ms` to accept each write — a device that is slow but making progress. */
  setWriteDelay(ms: number): void {
    this.#state.writeDelayMs = ms
  }

  /** Input lines the port sees through get(). */
  setStatus(status: Partial<ModemStatus>): void {
    Object.assign(this.#state.status, status)
  }

  /** Unplug: pending and later I/O on the open port rejects DISCONNECTED. */
  disconnect(): void {
    this.#state.connected = false
    this.#state.notify()
  }

  /**
   * Plug back in after disconnect(): the device is listed and can be opened
   * again. A port still open from before stays DISCONNECTED, like a real
   * handle to a device that went away, and doesn't keep it busy.
   */
  reconnect(): void {
    const state = this.#state
    if (state.connected) return
    state.connected = true
    state.plugs++
    state.openPort = null
    state.inbound = new Uint8Array(0)
    state.notify()
  }
}

export class MockBinding implements Binding {
  readonly name = 'mock'
  readonly capabilities = mockCapabilities
  readonly #devices = new Map<string, MockDevice>()

  /** Register a device at `path` and return its far end. */
  addPort(path: string, info: Omit<PortInfo, 'path'> = {}): MockDevice {
    if (this.#devices.has(path)) {
      throw new SerialPortError('INVALID_ARGUMENT', `Mock port already exists: ${path}`)
    }
    const device = new MockDevice({ ...info, path })
    this.#devices.set(path, device)
    return device
  }

  async list(): Promise<PortInfo[]> {
    return [...this.#devices.values()]
      .filter((device) => stateOf(device).connected)
      .map((device) => device.info)
  }

  async open(path: string, options: ResolvedOpenOptions): Promise<BindingPort> {
    const device = this.#devices.get(path)
    const state = device && stateOf(device)
    if (!state?.connected) throw new SerialPortError('NOT_FOUND', `No such port: ${path}`)
    // One open port per device regardless of `lock` — keeps the mock simple.
    if (state.openPort) throw new SerialPortError('BUSY', `Port is busy: ${path}`)

    state.inbound = new Uint8Array(0) // the real bindings flush stale bytes at open too
    const port = new MockBindingPort(path, options, state)
    state.openPort = port
    return port
  }
}

class MockBindingPort implements BindingPort {
  #options: ResolvedOpenOptions
  readonly #state: DeviceState
  readonly #plug: number
  #open = true

  constructor(
    readonly path: string,
    options: ResolvedOpenOptions,
    state: DeviceState,
  ) {
    this.#options = options
    this.#state = state
    this.#plug = state.plugs
  }

  get options(): ResolvedOpenOptions {
    return this.#options
  }

  get isOpen(): boolean {
    return this.#open
  }

  async read(buffer: Uint8Array, signal?: AbortSignal): Promise<number> {
    this.#assertUsable()
    while (this.#state.inbound.length === 0) {
      await this.#state.changed(signal)
      this.#assertUsable(true)
    }
    const count = Math.min(buffer.length, this.#state.inbound.length)
    buffer.set(this.#state.inbound.subarray(0, count))
    this.#state.inbound = this.#state.inbound.subarray(count)
    return count
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.#assertUsable()
    const stalledSince = Date.now()
    while (this.#state.stalled) {
      const remaining = this.#options.writeTimeout - (Date.now() - stalledSince)
      if (remaining <= 0) {
        throw new SerialPortError('TIMEOUT', `Device stopped accepting data: ${this.path}`)
      }
      await this.#state.changed(signal, remaining)
      this.#assertUsable(true)
    }
    if (this.#state.writeDelayMs > 0) {
      // Making progress, so close() and the signal don't interrupt it.
      await Bun.sleep(this.#state.writeDelayMs)
      this.#assertUsable(true)
    }
    this.#state.outbound.push(data.slice())
  }

  async drain(signal?: AbortSignal): Promise<void> {
    // Accepted bytes go out instantly unless the device is stalled; then
    // there's nothing left to wait for once the caller gives up.
    this.#assertUsable()
    while (this.#state.stalled) {
      await this.#state.changed(signal)
      this.#assertUsable(true)
    }
  }

  async update(options: UpdateOptions): Promise<void> {
    this.#assertUsable()
    this.#options = Object.freeze({ ...this.#options, baudRate: options.baudRate })
  }

  async set(lines: ModemLines): Promise<void> {
    this.#assertUsable()
    for (const key of ['dtr', 'rts', 'brk'] as const) {
      const value = lines[key]
      if (value !== undefined) this.#state.lines[key] = value
    }
  }

  async get(): Promise<ModemStatus> {
    this.#assertUsable()
    return { ...this.#state.status }
  }

  async flush(): Promise<void> {
    this.#assertUsable()
    this.#state.inbound = new Uint8Array(0)
  }

  async close(): Promise<void> {
    if (!this.#open) return
    this.#open = false
    if (this.#state.openPort === this) this.#state.openPort = null
    this.#state.notify() // a pending read wakes, sees the port closed, rejects CANCELED
  }

  // Before an operation a closed port is NOT_OPEN; closed while the
  // operation was waiting, it's CANCELED.
  #assertUsable(afterWait = false): void {
    if (!this.#open) {
      throw afterWait ? canceledError() : new SerialPortError('NOT_OPEN', `Port is not open: ${this.path}`)
    }
    if (!this.#state.connected || this.#plug !== this.#state.plugs) {
      throw new SerialPortError('DISCONNECTED', `Device disconnected: ${this.path}`)
    }
  }
}
