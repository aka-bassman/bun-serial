// The termios packing is pure, so both platform layouts are checked on any OS.

import { describe, expect, test } from 'bun:test'
import { darwinConstants, linuxConstants, type PosixConstants } from '../src/bindings/posix/constants.js'
import { errnoCode } from '../src/bindings/posix/ffi.js'
import { configureTermios, readFlag, setTermios2Speed, writeFlag } from '../src/bindings/posix/termios.js'

type LineOptions = Parameters<typeof configureTermios>[1]

const base: LineOptions = {
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  rtscts: false,
  xon: false,
  xoff: false,
  xany: false,
  hupcl: true,
}

function configured(c: PosixConstants, options: Partial<LineOptions> = {}) {
  const termios = new Uint8Array(c.termios.size).fill(0xff) // whatever tcgetattr left behind
  configureTermios(termios, { ...base, ...options }, c)
  const view = new DataView(termios.buffer)
  const flag = (offset: number) => readFlag(view, offset, c.termios.flagSize)
  return {
    termios,
    cflag: flag(c.termios.cflag),
    iflag: flag(c.termios.iflag),
    oflag: flag(c.termios.oflag),
    lflag: flag(c.termios.lflag),
  }
}

for (const c of [linuxConstants, darwinConstants]) {
  describe(`configureTermios (${c.platform})`, () => {
    test('8N1 raw mode with the receiver enabled and modem control ignored', () => {
      const { cflag, iflag, oflag, lflag, termios } = configured(c)
      expect(cflag & c.CSIZE).toBe(c.CS8)
      expect(cflag & (c.CREAD | c.CLOCAL)).toBe(c.CREAD | c.CLOCAL)
      expect(cflag & (c.CSTOPB | c.PARENB | c.PARODD | c.CRTSCTS)).toBe(0)
      expect(iflag).toBe(c.IGNPAR)
      expect(oflag).toBe(0)
      expect(lflag).toBe(0)
      expect(termios[c.termios.cc + c.VMIN]).toBe(1)
      expect(termios[c.termios.cc + c.VTIME]).toBe(0)
    })

    test('the flag fields keep their width', () => {
      // On macOS tcflag_t is 64 bits; the upper half must be cleared, not left as garbage.
      const { termios } = configured(c)
      if (c.termios.flagSize === 8) {
        const view = new DataView(termios.buffer)
        expect(view.getUint32(c.termios.cflag + 4, true)).toBe(0)
      }
    })

    test('data bits, stop bits and parity', () => {
      expect(configured(c, { dataBits: 7 }).cflag & c.CSIZE).toBe(c.CS7)
      expect(configured(c, { dataBits: 5 }).cflag & c.CSIZE).toBe(c.CS5)
      expect(configured(c, { stopBits: 2 }).cflag & c.CSTOPB).toBe(c.CSTOPB)

      const even = configured(c, { parity: 'even' })
      expect(even.cflag & (c.PARENB | c.PARODD)).toBe(c.PARENB)
      expect(even.iflag & c.INPCK).toBe(c.INPCK)

      const odd = configured(c, { parity: 'odd' })
      expect(odd.cflag & (c.PARENB | c.PARODD)).toBe(c.PARENB | c.PARODD)
    })

    test('flow control and hang-up', () => {
      expect((configured(c, { rtscts: true }).cflag & c.CRTSCTS) >>> 0).toBe(c.CRTSCTS)
      expect(configured(c, { hupcl: true }).cflag & c.HUPCL).toBe(c.HUPCL)
      expect(configured(c, { hupcl: false }).cflag & c.HUPCL).toBe(0)
      const soft = configured(c, { xon: true, xoff: true, xany: true }).iflag
      expect(soft & (c.IXON | c.IXOFF | c.IXANY)).toBe(c.IXON | c.IXOFF | c.IXANY)
    })

    test('errno values map to portable codes', () => {
      expect(errnoCode(c.errno.ENOENT, c)).toBe('NOT_FOUND')
      expect(errnoCode(c.errno.EACCES, c)).toBe('ACCESS_DENIED')
      expect(errnoCode(c.errno.EBUSY, c)).toBe('BUSY')
      expect(errnoCode(c.errno.EIO, c)).toBe('DISCONNECTED')
      expect(errnoCode(c.errno.ENOTTY, c)).toBe('UNSUPPORTED')
      expect(errnoCode(c.errno.EAGAIN, c)).toBe('IO')
    })
  })
}

test('Linux mark and space parity use CMSPAR', () => {
  const c = linuxConstants
  const parityBits = c.PARENB | c.CMSPAR | c.PARODD
  expect(configured(c, { parity: 'mark' }).cflag & parityBits).toBe(parityBits)
  expect(configured(c, { parity: 'space' }).cflag & parityBits).toBe(c.PARENB | c.CMSPAR)
})

test('Linux CRTSCTS survives as an unsigned 32-bit flag', () => {
  const c = linuxConstants
  expect(configured(c, { rtscts: true }).cflag >>> 0).toBeGreaterThanOrEqual(0x80000000)
})

test('termios2 selects BOTHER with the literal rate and clears the input baud', () => {
  const c = linuxConstants
  const t2 = c.termios2!
  const termios2 = new Uint8Array(t2.size)
  const view = new DataView(termios2.buffer)
  view.setUint32(t2.cflag, 0o10002 | (0o10002 << t2.IBSHIFT) | c.CS8, true) // B115200 in and out
  setTermios2Speed(termios2, 250000, c)
  const cflag = view.getUint32(t2.cflag, true)
  expect(cflag & t2.CBAUD).toBe(t2.BOTHER)
  expect(cflag & (t2.CBAUD << t2.IBSHIFT)).toBe(0)
  expect(cflag & c.CSIZE).toBe(c.CS8)
  expect(view.getUint32(t2.ispeed, true)).toBe(250000)
  expect(view.getUint32(t2.ospeed, true)).toBe(250000)
})

test('the Linux speed table matches <termios.h>', () => {
  expect(linuxConstants.speeds.get(9600)).toBe(0o15)
  expect(linuxConstants.speeds.get(115200)).toBe(0x1002)
  expect(linuxConstants.speeds.get(4000000)).toBe(0x100f)
  expect(darwinConstants.speeds.get(115200)).toBe(115200)
  expect(darwinConstants.speeds.has(921600)).toBe(false) // goes through IOSSIOSPEED
})

test('writeFlag/readFlag round-trip in both widths', () => {
  const view = new DataView(new ArrayBuffer(8))
  writeFlag(view, 0, 0x80000001, 8)
  expect(readFlag(view, 0, 8)).toBe(0x80000001)
  writeFlag(view, 0, 0x80000001, 4)
  expect(readFlag(view, 0, 4)).toBe(0x80000001)
})
