// libc through bun:ffi, loaded on first use so importing the binding costs
// nothing on a platform that never opens a port.

import { dlopen, FFIType, read } from 'bun:ffi'
import { SerialPortError, type SerialErrorCode } from '../../errors.js'
import type { PosixConstants } from './constants.js'

const symbols = {
  open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
  write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  cfsetispeed: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  cfsetospeed: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  strerror: { args: [FFIType.i32], returns: FFIType.cstring },
} as const

// ioctl(int, unsigned long, ...) takes its argument through varargs. Apple's
// arm64 ABI passes variadic arguments on the stack, so a plain three-argument
// call leaves the pointer in x2 where ioctl never looks — the kernel then
// writes through whatever happens to be on the stack. Six filler arguments
// occupy x2–x7 and push the real one into the first stack slot, which is
// exactly where va_arg reads it. Everywhere else varargs travel in registers.
const ioctlInRegisters = {
  ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
} as const
const ioctlOnStack = {
  ioctl: {
    args: [
      FFIType.i32, FFIType.u64,
      FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
} as const

export interface Libc {
  /** The library actually loaded, e.g. libc.so.6. */
  readonly path: string
  open(path: string, flags: number): number
  close(fd: number): number
  read(fd: number, buffer: Uint8Array): number
  write(fd: number, data: Uint8Array): number
  flock(fd: number, operation: number): number
  tcgetattr(fd: number, termios: Uint8Array): number
  tcsetattr(fd: number, action: number, termios: Uint8Array): number
  tcflush(fd: number, queue: number): number
  cfsetispeed(termios: Uint8Array, speed: number): number
  cfsetospeed(termios: Uint8Array, speed: number): number
  /** `arg` is the pointer argument; null for requests that take none. */
  ioctl(fd: number, request: number, arg: Uint8Array | null): number
  errno(): number
  strerror(errno: number): string
}

const loaded = new Map<string, Libc>()
const textEncoder = new TextEncoder()

export function loadLibc(c: PosixConstants): Libc {
  const cached = loaded.get(c.platform)
  if (cached) return cached

  const path = openableLibrary(c.libc)
  const lib = dlopen(path, symbols).symbols
  const errnoLocation =
    c.errnoSymbol === '__error'
      ? dlopen(path, { __error: { args: [], returns: FFIType.ptr } } as const).symbols.__error
      : dlopen(path, { __errno_location: { args: [], returns: FFIType.ptr } } as const).symbols.__errno_location

  let ioctl: (fd: number, request: number, arg: Uint8Array | null) => number
  if (c.platform === 'darwin' && process.arch === 'arm64') {
    const call = dlopen(path, ioctlOnStack).symbols.ioctl
    ioctl = (fd, request, arg) => call(fd, request, 0, 0, 0, 0, 0, 0, arg)
  } else {
    const call = dlopen(path, ioctlInRegisters).symbols.ioctl
    ioctl = (fd, request, arg) => call(fd, request, arg)
  }

  const libc: Libc = {
    path,
    open: (pathname, flags) => lib.open(textEncoder.encode(`${pathname}\0`), flags),
    close: (fd) => lib.close(fd),
    read: (fd, buffer) => Number(lib.read(fd, buffer, buffer.length)),
    write: (fd, data) => Number(lib.write(fd, data, data.length)),
    flock: (fd, operation) => lib.flock(fd, operation),
    tcgetattr: (fd, termios) => lib.tcgetattr(fd, termios),
    tcsetattr: (fd, action, termios) => lib.tcsetattr(fd, action, termios),
    tcflush: (fd, queue) => lib.tcflush(fd, queue),
    cfsetispeed: (termios, speed) => lib.cfsetispeed(termios, speed),
    cfsetospeed: (termios, speed) => lib.cfsetospeed(termios, speed),
    ioctl: (fd, request, arg) => ioctl(fd, request, arg),
    errno: () => {
      const location = errnoLocation()
      return location === null ? 0 : read.i32(location, 0)
    },
    strerror: (errno) => lib.strerror(errno) ?? `errno ${errno}`,
  }
  loaded.set(c.platform, libc)
  return libc
}

function openableLibrary(candidates: readonly string[]): string {
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      dlopen(candidate, { close: symbols.close }).close()
      return candidate
    } catch (err) {
      lastError = err
    }
  }
  throw new SerialPortError('UNSUPPORTED', `Cannot load libc (tried ${candidates.join(', ')})`, {
    cause: lastError,
  })
}

export interface ErrnoErrorOptions {
  /** Port path, for the message. */
  path?: string
  /** Code to report instead of the errno-derived one. */
  code?: SerialErrorCode
}

/** A SerialPortError for a failed libc call, with the errno mapped to a portable code. */
export function errnoError(
  libc: Libc,
  c: PosixConstants,
  syscall: string,
  errno: number,
  options: ErrnoErrorOptions = {},
): SerialPortError {
  const where = options.path === undefined ? syscall : `${syscall} ${options.path}`
  return new SerialPortError(options.code ?? errnoCode(errno, c), `${where}: ${libc.strerror(errno)}`, {
    syscall,
    osCode: errno,
  })
}

export function errnoCode(errno: number, c: PosixConstants): SerialErrorCode {
  const e = c.errno
  switch (errno) {
    case e.ENOENT:
      return 'NOT_FOUND'
    case e.EACCES:
    case e.EPERM:
      return 'ACCESS_DENIED'
    case e.EBUSY:
      return 'BUSY'
    case e.EIO:
    case e.ENXIO:
    case e.ENODEV:
      return 'DISCONNECTED'
    case e.ENOTTY:
    case e.EINVAL:
      return 'UNSUPPORTED'
    default:
      return 'IO'
  }
}
