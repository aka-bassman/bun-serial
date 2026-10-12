// A pseudo-terminal pair through libc. The slave end behaves like a serial
// device for SerialPort; the master end is the far side tests drive.

import { CString, dlopen, FFIType } from 'bun:ffi'
import { concatBytes } from '../../src/internal/bytes.js'
import { posixConstants } from '../../src/bindings/posix/constants.js'

export const isPosix = process.platform === 'linux' || process.platform === 'darwin'
export const constants = posixConstants(process.platform === 'linux' ? 'linux' : 'darwin')

const symbols = {
  posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
  grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
  unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
  ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
  open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
  write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
} as const

let libc: ReturnType<typeof dlopen<typeof symbols>>['symbols'] | undefined
function lib() {
  libc ??= dlopen(constants.libc[0]!, symbols).symbols
  return libc
}

export interface Pty {
  readonly masterFd: number
  readonly slavePath: string
  /** Whatever is buffered on the master right now. */
  readMaster(): Uint8Array
  /** Read the master until `total` bytes arrive or `timeoutMs` passes. */
  collect(total: number, timeoutMs?: number): Promise<Uint8Array>
  writeMaster(bytes: Uint8Array | string): number
  closeMaster(): void
}

export function openPty(): Pty {
  const c = constants
  const libc = lib()
  const masterFd = libc.posix_openpt(c.O_RDWR | c.O_NOCTTY | c.O_NONBLOCK)
  if (masterFd < 0) throw new Error('posix_openpt failed')
  if (libc.grantpt(masterFd) < 0 || libc.unlockpt(masterFd) < 0) throw new Error('grantpt/unlockpt failed')
  const name = libc.ptsname(masterFd)
  if (!name) throw new Error('ptsname failed')
  const slavePath = new CString(name).toString()
  const buffer = new Uint8Array(65536)
  let open = true

  const readMaster = () => {
    const count = Number(libc.read(masterFd, buffer, buffer.length))
    return count > 0 ? buffer.slice(0, count) : new Uint8Array(0)
  }

  return {
    masterFd,
    slavePath,
    readMaster,
    async collect(total, timeoutMs = 5000) {
      const chunks: Uint8Array[] = []
      let received = 0
      const deadline = Date.now() + timeoutMs
      while (received < total && Date.now() < deadline) {
        const chunk = readMaster()
        if (chunk.length > 0) {
          chunks.push(chunk)
          received += chunk.length
        } else {
          await Bun.sleep(2)
        }
      }
      return concatBytes(chunks)
    },
    writeMaster(bytes) {
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      return Number(libc.write(masterFd, data, data.length))
    },
    closeMaster() {
      if (open) libc.close(masterFd)
      open = false
    },
  }
}

/** c_iflag as the tty currently has it — termios state is per device, so a second fd sees it. */
export function readIflag(path: string): number {
  const c = constants
  const libc = lib()
  const fd = libc.open(new TextEncoder().encode(`${path}\0`), c.O_RDWR | c.O_NOCTTY | c.O_NONBLOCK)
  if (fd < 0) throw new Error(`open ${path} failed`)
  const termios = new Uint8Array(c.termios.size)
  const rc = libc.tcgetattr(fd, termios)
  libc.close(fd)
  if (rc < 0) throw new Error('tcgetattr failed')
  const view = new DataView(termios.buffer)
  return c.termios.flagSize === 4 ? view.getUint32(c.termios.iflag, true) : Number(view.getBigUint64(c.termios.iflag, true))
}
