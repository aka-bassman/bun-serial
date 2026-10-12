// Packs open options into the bytes of a struct termios. Pure — no FFI — so
// both platform layouts are unit-tested on any OS.

import type { DataBits, ResolvedOpenOptions } from '../../options.js'
import type { PosixConstants } from './constants.js'

type LineOptions = Pick<
  ResolvedOpenOptions,
  'dataBits' | 'stopBits' | 'parity' | 'rtscts' | 'xon' | 'xoff' | 'xany' | 'hupcl'
>

/** Turn the termios that tcgetattr() filled into a raw port with these settings. */
export function configureTermios(termios: Uint8Array, options: LineOptions, c: PosixConstants): void {
  const layout = c.termios
  const view = new DataView(termios.buffer, termios.byteOffset, termios.byteLength)

  let cflag = readFlag(view, layout.cflag, layout.flagSize)
  cflag &= ~(c.CSIZE | c.CSTOPB | c.PARENB | c.PARODD | c.CMSPAR | c.CRTSCTS | c.HUPCL)
  cflag |= dataBitsFlag(options.dataBits, c) | c.CREAD | c.CLOCAL
  if (options.stopBits === 2) cflag |= c.CSTOPB
  switch (options.parity) {
    case 'even':
      cflag |= c.PARENB
      break
    case 'odd':
      cflag |= c.PARENB | c.PARODD
      break
    case 'mark':
      cflag |= c.PARENB | c.CMSPAR | c.PARODD
      break
    case 'space':
      cflag |= c.PARENB | c.CMSPAR
      break
  }
  if (options.rtscts) cflag |= c.CRTSCTS
  // Drop DTR/RTS on the last close. Boards that reset on a DTR edge need
  // hupcl: false to survive an open-write-close sequence.
  if (options.hupcl) cflag |= c.HUPCL
  writeFlag(view, layout.cflag, cflag, layout.flagSize)

  // Raw input. IGNPAR matches node-serialport: a byte failing the parity
  // check is dropped, not delivered as a NUL to be mistaken for data.
  let iflag = c.IGNPAR
  if (options.parity !== 'none') iflag |= c.INPCK
  if (options.xon) iflag |= c.IXON
  if (options.xoff) iflag |= c.IXOFF
  if (options.xany) iflag |= c.IXANY
  writeFlag(view, layout.iflag, iflag, layout.flagSize)
  writeFlag(view, layout.oflag, 0, layout.flagSize)
  writeFlag(view, layout.lflag, 0, layout.flagSize)

  termios.fill(0, layout.cc, layout.cc + c.NCCS)
  termios[layout.cc + c.VMIN] = 1
  termios[layout.cc + c.VTIME] = 0
}

export function readFlag(view: DataView, offset: number, size: 4 | 8): number {
  // Every flag fits in 32 bits, even where tcflag_t is 64 bits wide.
  return size === 4 ? view.getUint32(offset, true) : Number(view.getBigUint64(offset, true) & 0xffffffffn)
}

export function writeFlag(view: DataView, offset: number, value: number, size: 4 | 8): void {
  if (size === 4) view.setUint32(offset, value >>> 0, true)
  else view.setBigUint64(offset, BigInt(value >>> 0), true)
}

function dataBitsFlag(bits: DataBits, c: PosixConstants): number {
  switch (bits) {
    case 5:
      return c.CS5
    case 6:
      return c.CS6
    case 7:
      return c.CS7
    case 8:
      return c.CS8
  }
}

/** Linux termios2: switch an existing struct to an arbitrary rate via BOTHER. */
export function setTermios2Speed(termios2: Uint8Array, baudRate: number, c: PosixConstants): void {
  const t2 = c.termios2
  if (!t2) throw new Error('termios2 is Linux-only')
  const view = new DataView(termios2.buffer, termios2.byteOffset, termios2.byteLength)
  let cflag = view.getUint32(t2.cflag, true)
  // Clear CBAUD and CIBAUD (input speed follows output), then select BOTHER.
  cflag &= ~(t2.CBAUD | (t2.CBAUD << t2.IBSHIFT))
  cflag |= t2.BOTHER
  view.setUint32(t2.cflag, cflag >>> 0, true)
  view.setUint32(t2.ispeed, baudRate, true)
  view.setUint32(t2.ospeed, baudRate, true)
}
