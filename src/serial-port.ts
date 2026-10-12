// SerialPort: the platform-neutral half. Owns the lifecycle (open, close,
// reopen), the read loop that turns BindingPort.read() into 'data' events,
// and the output chain that keeps write(), drain() and update() in order.

import { EventEmitter } from 'node:events'
import { defaultBinding } from './bindings/index.js'
import type { Binding, BindingPort, ModemLines, ModemStatus, UpdateOptions } from './bindings/types.js'
import {
  invalidArgument,
  isSerialPortError,
  notOpenError,
  SerialPortError,
  toSerialPortError,
} from './errors.js'
import { snapshotBytes, type WriteData } from './internal/bytes.js'
import {
  resolveOpenOptions,
  validateBaudRate,
  type ResolvedOpenOptions,
  type SerialPortOptions,
} from './options.js'
import type { Parser } from './parsers/types.js'

export interface SerialPortEvents {
  open: []
  data: [chunk: Uint8Array]
  /** Errors nobody asked for: a failed autoOpen, or a failed read (the port then closes). */
  error: [error: SerialPortError]
  /** A close caused by a failed read receives that error; close() emits no argument. */
  close: [cause?: SerialPortError]
}

const DEFAULT_READ_BUFFER_SIZE = 65536
const MODEM_LINES: readonly string[] = ['dtr', 'rts', 'brk']
const noop = () => {}

// One open → close cycle. Reopening starts a fresh session.
interface Session {
  readonly port: BindingPort
  /** Aborted when close() starts, so output stalled on the device gives up instead of holding the close. */
  readonly closing: AbortController
  readLoop: Promise<void>
  /** close() abandoned output the device wasn't taking. */
  outputStalled: boolean
}

export class SerialPort extends EventEmitter<SerialPortEvents> {
  readonly #path: string
  readonly #binding: Binding
  #options: ResolvedOpenOptions
  readonly #readBuffer: Uint8Array
  readonly #pipes = new Map<Parser, (chunk: Uint8Array) => void>()
  #session: Session | null = null
  /**
   * Tail of the output chain: write(), drain() and update() run one at a
   * time, in call order. Calls join it synchronously, before any await, so a
   * close() made right after a write() still waits for that write.
   */
  #output: Promise<void> = Promise.resolve()
  #opening: Promise<void> | null = null
  #closing: Promise<void> | null = null
  #closeCause: SerialPortError | null = null

  constructor(options: SerialPortOptions) {
    super()
    if (typeof options !== 'object' || options === null) throw invalidArgument('options', options)
    const { path, autoOpen = true, readBufferSize = DEFAULT_READ_BUFFER_SIZE } = options
    if (typeof path !== 'string' || path === '') throw invalidArgument('path', path)
    if (typeof autoOpen !== 'boolean') throw invalidArgument('autoOpen', autoOpen)
    if (!Number.isInteger(readBufferSize) || readBufferSize < 1) {
      throw invalidArgument('readBufferSize', readBufferSize)
    }
    const binding = options.binding ?? defaultBinding()
    if (!isBinding(binding)) throw invalidArgument('binding', binding)

    this.#path = path
    this.#binding = binding
    this.#options = resolveOpenOptions(options, binding.capabilities)
    this.#readBuffer = new Uint8Array(readBufferSize)

    if (autoOpen) {
      // Start on the next microtask so the caller can attach listeners first,
      // but set #opening now so methods called meanwhile wait for it.
      const opening = Promise.resolve()
        .then(() => this.#performOpen(null))
        .finally(() => {
          this.#opening = null
        })
      opening.catch((err: unknown) => this.#emitSafely('error', toSerialPortError(err)))
      this.#opening = opening
    }
  }

  get path(): string {
    return this.#path
  }

  get baudRate(): number {
    return this.#options.baudRate
  }

  /** True while open and not closing. */
  get isOpen(): boolean {
    return this.#session !== null && this.#closing === null
  }

  /** Open the port (only needed with autoOpen: false). Resolves once it's ready for I/O. */
  open(): Promise<void> {
    this.#opening ??= this.#performOpen(this.#closing).finally(() => {
      this.#opening = null
    })
    return this.#opening
  }

  /**
   * Let queued output reach the wire, then close. Output the device has
   * stopped taking is abandoned rather than waited on forever.
   */
  close(): Promise<void> {
    this.#closing ??= this.#performClose(this.#output).finally(() => {
      this.#closing = null
    })
    return this.#closing
  }

  /**
   * Resolves once the OS has accepted every byte; drain() waits for them to be
   * transmitted. The data is copied, so the caller may reuse its buffer at once.
   */
  write(data: WriteData): Promise<void> {
    let bytes: Uint8Array
    try {
      bytes = snapshotBytes(data)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.#enqueue(async (session) => {
      if (bytes.length > 0) await session.port.write(bytes, session.closing.signal)
    })
  }

  /** Resolves once everything written so far has been transmitted. */
  drain(): Promise<void> {
    return this.#enqueue((session) => session.port.drain(session.closing.signal))
  }

  /** Change the baud rate once output written so far has been transmitted. */
  update(options: UpdateOptions): Promise<void> {
    let baudRate: number
    try {
      if (typeof options !== 'object' || options === null) throw invalidArgument('options', options)
      baudRate = validateBaudRate(options.baudRate, this.#binding.capabilities)
    } catch (err) {
      return Promise.reject(err)
    }
    return this.#enqueue(async (session) => {
      await session.port.drain(session.closing.signal)
      await session.port.update({ baudRate })
      this.#options = Object.freeze({ ...this.#options, baudRate })
    })
  }

  /** Set DTR/RTS and the break condition; omitted keys are left as they are. */
  async set(lines: ModemLines): Promise<void> {
    if (typeof lines !== 'object' || lines === null) throw invalidArgument('lines', lines)
    const changes: ModemLines = {}
    for (const [key, value] of Object.entries(lines)) {
      if (!MODEM_LINES.includes(key)) {
        throw new SerialPortError('INVALID_ARGUMENT', `Invalid set() flag: ${key}`)
      }
      if (value === undefined) continue
      if (typeof value !== 'boolean') throw invalidArgument(key, value)
      changes[key as keyof ModemLines] = value
    }
    const session = await this.#activeSession()
    await session.port.set(changes)
  }

  /** Read the input lines: CTS, DSR, DCD, RI. */
  async get(): Promise<ModemStatus> {
    const session = await this.#activeSession()
    return session.port.get()
  }

  /** Discard unread input and untransmitted output. */
  async flush(): Promise<void> {
    const session = await this.#activeSession()
    await session.port.flush()
  }

  /** Feed every incoming chunk to `parser`; returns the parser for chaining. */
  pipe<T extends Parser>(parser: T): T {
    if (!this.#pipes.has(parser)) {
      const forward = (chunk: Uint8Array) => parser.push(chunk)
      this.#pipes.set(parser, forward)
      this.on('data', forward)
    }
    return parser
  }

  unpipe(parser: Parser): void {
    const forward = this.#pipes.get(parser)
    if (!forward) return
    this.off('data', forward)
    this.#pipes.delete(parser)
  }

  /** `await using port = new SerialPort(...)` closes the port on scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#opening) await this.#opening.catch(noop)
    if (this.#session) await this.close()
  }

  // Waits only for a close that was already underway when open() was called:
  // a close() requested during this open waits for the open instead.
  async #performOpen(priorClose: Promise<void> | null): Promise<void> {
    if (priorClose) await priorClose.catch(noop)
    if (this.#session) throw new SerialPortError('ALREADY_OPEN', `Port is already open: ${this.#path}`)

    const port = await this.#binding.open(this.#path, this.#options)
    const session: Session = {
      port,
      closing: new AbortController(),
      readLoop: Promise.resolve(),
      outputStalled: false,
    }
    this.#session = session
    session.readLoop = this.#readLoop(session)
    this.#emitSafely('open')
  }

  // `pendingOutput` is the output chain as it stood when close() was called:
  // everything queued before it is let out, nothing queued after.
  async #performClose(pendingOutput: Promise<void>): Promise<void> {
    if (this.#opening) await this.#opening.catch(noop)
    const session = this.#session
    if (!session) throw notOpenError(this.#path)
    const { port, closing } = session

    // Stalled writes give up now; ones still making progress finish first.
    closing.abort()
    await pendingOutput

    // write() resolves when the OS has the bytes, not when they're sent, so
    // drain before closing — unless the device is gone or already not taking
    // output. Undeliverable output is discarded: on Linux, closing a tty with
    // queued output blocks for up to 30 seconds.
    const deviceGone = this.#closeCause !== null
    if (!deviceGone && !session.outputStalled) {
      await port.drain(closing.signal).catch(() => {
        session.outputStalled = true
      })
    }
    if (!deviceGone && session.outputStalled) await port.flush().catch(noop)

    await port.close().catch(noop)
    await session.readLoop
    this.#session = null

    const cause = this.#closeCause
    this.#closeCause = null
    if (cause) this.#emitSafely('close', cause)
    else this.#emitSafely('close')
  }

  async #readLoop(session: Session): Promise<void> {
    const buffer = this.#readBuffer
    for (;;) {
      let count: number
      try {
        count = await session.port.read(buffer)
      } catch (err) {
        if (!session.closing.signal.aborted) this.#fail(toSerialPortError(err))
        return
      }
      this.#emitSafely('data', buffer.slice(0, count))
    }
  }

  // A read failed — usually the device went away. Report it, and close so the
  // OS handle is released; the 'close' event carries the same error.
  #fail(error: SerialPortError): void {
    this.#closeCause = error
    this.close().catch(noop)
    this.#emitSafely('error', error)
  }

  async #activeSession(): Promise<Session> {
    if (this.#opening) await this.#opening.catch(noop)
    const session = this.#session
    if (!session || this.#closing) throw notOpenError(this.#path)
    return session
  }

  // Join the output chain now, synchronously. An operation queued while an
  // open is in progress runs once it finishes; otherwise the port must be open
  // and not closing.
  #enqueue<T>(operation: (session: Session) => Promise<T>): Promise<T> {
    const opening = this.#opening
    if (!opening && (this.#session === null || this.#closing !== null)) {
      return Promise.reject(notOpenError(this.#path))
    }
    let ranOn: Session | null = null
    const job = this.#output.then(async () => {
      if (opening) await opening.catch(noop)
      const session = this.#session
      if (!session) throw notOpenError(this.#path)
      ranOn = session
      return operation(session)
    })
    this.#output = job.then(noop, (err: unknown) => {
      // Output the device refused to take while closing: close() must not wait on it again.
      if (ranOn?.closing.signal.aborted && isSerialPortError(err, 'CANCELED')) ranOn.outputStalled = true
    })
    return job
  }

  // Listener exceptions must not unwind into the read loop or the close
  // sequence. Rethrow them on their own microtask so they surface as uncaught
  // exceptions, like any other event handler error — including an 'error'
  // event nobody listens to.
  #emitSafely<K extends keyof SerialPortEvents>(event: K, ...args: SerialPortEvents[K]): void {
    try {
      this.emit(event, ...(args as never))
    } catch (err) {
      queueMicrotask(() => {
        throw err
      })
    }
  }
}

function isBinding(value: unknown): value is Binding {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Binding>
  return (
    typeof candidate.open === 'function' &&
    typeof candidate.list === 'function' &&
    typeof candidate.capabilities === 'object'
  )
}
