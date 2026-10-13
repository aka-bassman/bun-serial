// Error type shared by every binding. Codes are normalized across platforms so
// callers never have to tell errno values from Win32 error codes apart; the raw
// OS value stays available in `osCode` for diagnostics.

export type SerialErrorCode =
  | 'INVALID_ARGUMENT' // malformed option or argument
  | 'UNSUPPORTED' // valid in general, but not on this platform, binding or device
  | 'NOT_FOUND' // no such port
  | 'ACCESS_DENIED' // OS permission (Linux: usually the dialout group)
  | 'BUSY' // held by another process or port object
  | 'NOT_OPEN' // operation needs an open port
  | 'ALREADY_OPEN' // open() on an open port
  | 'DISCONNECTED' // device went away while open
  | 'CANCELED' // interrupted by close() or an AbortSignal
  | 'TIMEOUT' // a write stalled for longer than writeTimeout
  | 'QUEUE_FULL' // write() with maxQueuedWrites already pending
  | 'IO' // any other OS failure — see osCode/syscall

export interface SerialPortErrorOptions {
  syscall?: string
  osCode?: number
  cause?: unknown
}

export class SerialPortError extends Error {
  override readonly name = 'SerialPortError'
  readonly code: SerialErrorCode
  readonly syscall: string | undefined
  /** errno on POSIX, GetLastError() value on Windows. */
  readonly osCode: number | undefined

  constructor(code: SerialErrorCode, message: string, options: SerialPortErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.code = code
    this.syscall = options.syscall
    this.osCode = options.osCode
  }
}

/** True if `value` is a SerialPortError, optionally with the given code. */
export function isSerialPortError(value: unknown, code?: SerialErrorCode): value is SerialPortError {
  return value instanceof SerialPortError && (code === undefined || value.code === code)
}

export function canceledError(): SerialPortError {
  return new SerialPortError('CANCELED', 'Operation canceled')
}

export function notOpenError(path: string): SerialPortError {
  return new SerialPortError('NOT_OPEN', `Port is not open: ${path}`)
}

export function invalidArgument(name: string, value: unknown): SerialPortError {
  return new SerialPortError('INVALID_ARGUMENT', `Invalid ${name}: ${describe(value)}`)
}

/** Wrap anything thrown below the binding contract so callers only ever see SerialPortError. */
export function toSerialPortError(value: unknown): SerialPortError {
  if (value instanceof SerialPortError) return value
  const message = value instanceof Error ? value.message : String(value)
  return new SerialPortError('IO', message, { cause: value })
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}
