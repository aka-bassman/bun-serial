// The Windows binding's pure half — struct packing, strings, IDs, error
// mapping — checked on every OS. The FFI half needs Windows (win32-ffi.test.ts).

import { describe, expect, test } from 'bun:test'
import {
  COMSTAT,
  DCB,
  ERROR_ACCESS_DENIED,
  ERROR_DEVICE_NOT_CONNECTED,
  ERROR_FILE_NOT_FOUND,
  ERROR_GEN_FAILURE,
  ERROR_INVALID_PARAMETER,
  ERROR_OPERATION_ABORTED,
  ERROR_SHARING_VIOLATION,
  fAbortOnError,
  fBinary,
  fDtrControlShift,
  fInX,
  fNull,
  fOutX,
  fOutxCtsFlow,
  fParity,
  fRtsControlShift,
  fTXContinueOnXoff,
  GENERIC_READ_WRITE,
  GUID_DEVCLASS_PORTS,
  OVERLAPPED,
  SP_DEVINFO_DATA,
} from '../src/bindings/win32/constants.js'
import { ioErrorCode, openErrorCode, validHandle } from '../src/bindings/win32/ffi.js'
import {
  checkLineSettings,
  commTimeouts,
  configureDcb,
  devicePath,
  fromWide,
  initialLines,
  parseInstanceId,
  setLineControl,
  wide,
} from '../src/bindings/win32/structs.js'
import type { ResolvedOpenOptions } from '../src/options.js'
import { errorCode } from './helpers/errors.js'

type LineOptions = Parameters<typeof configureDcb>[1]

const base: LineOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  rtscts: false,
  xon: false,
  xoff: false,
  hupcl: true,
}

function dcbFor(options: Partial<LineOptions> = {}) {
  // Start from a hostile DCB: every bit set, as a previous user might leave it.
  const dcb = new Uint8Array(DCB.size).fill(0xff)
  configureDcb(dcb, { ...base, ...options })
  const view = new DataView(dcb.buffer)
  const flags = view.getUint32(DCB.flags, true)
  return {
    dcb,
    view,
    flags,
    dtr: (flags >> fDtrControlShift) & 0b11,
    rts: (flags >> fRtsControlShift) & 0b11,
  }
}

describe('configureDcb', () => {
  test('115200 8N1 with DTR and RTS asserted and every stray flag cleared', () => {
    const { dcb, view, flags, dtr, rts } = dcbFor()
    expect(view.getUint32(DCB.DCBlength, true)).toBe(28)
    expect(view.getUint32(DCB.BaudRate, true)).toBe(115200)
    expect(dcb[DCB.ByteSize]).toBe(8)
    expect(dcb[DCB.Parity]).toBe(0)
    expect(dcb[DCB.StopBits]).toBe(0)
    expect(flags & fBinary).toBe(fBinary)
    expect(flags & (fParity | fOutxCtsFlow | fOutX | fInX | fNull | fAbortOnError)).toBe(0)
    expect(dtr).toBe(1) // DTR_CONTROL_ENABLE
    expect(rts).toBe(1) // RTS_CONTROL_ENABLE: both up, as on POSIX
    expect(dcb[DCB.XonChar]).toBe(0x11)
    expect(dcb[DCB.XoffChar]).toBe(0x13)
  })

  test('parity, data bits and stop bits use the DCB codes', () => {
    expect(dcbFor({ parity: 'odd' }).dcb[DCB.Parity]).toBe(1)
    expect(dcbFor({ parity: 'even' }).dcb[DCB.Parity]).toBe(2)
    expect(dcbFor({ parity: 'mark' }).dcb[DCB.Parity]).toBe(3)
    expect(dcbFor({ parity: 'space' }).dcb[DCB.Parity]).toBe(4)
    expect(dcbFor({ parity: 'even' }).flags & fParity).toBe(fParity)
    expect(dcbFor({ dataBits: 7 }).dcb[DCB.ByteSize]).toBe(7)
    expect(dcbFor({ stopBits: 2 }).dcb[DCB.StopBits]).toBe(2)
    expect(dcbFor({ dataBits: 5, stopBits: 1.5 }).dcb[DCB.StopBits]).toBe(1)
  })

  test('rtscts hands RTS to the driver and watches CTS', () => {
    const { flags, rts } = dcbFor({ rtscts: true })
    expect(flags & fOutxCtsFlow).toBe(fOutxCtsFlow)
    expect(rts).toBe(2) // RTS_CONTROL_HANDSHAKE
  })

  test('xon/xoff map to fOutX/fInX, and our output keeps flowing after we send XOFF', () => {
    const { flags } = dcbFor({ xon: true, xoff: true })
    expect(flags & (fOutX | fInX)).toBe(fOutX | fInX)
    expect(flags & fTXContinueOnXoff).toBe(fTXContinueOnXoff)
  })

  test('hupcl: false keeps DTR and RTS down from open', () => {
    // DTR down with RTS up would hold an ESP32/ESP8266 auto-reset circuit in reset.
    const { dtr, rts } = dcbFor({ hupcl: false })
    expect(dtr).toBe(0) // DTR_CONTROL_DISABLE
    expect(rts).toBe(0) // RTS_CONTROL_DISABLE
  })

  test('with rtscts, RTS stays with the driver even when hupcl is false', () => {
    expect(dcbFor({ hupcl: false, rtscts: true }).rts).toBe(2)
  })
})

describe('setLineControl', () => {
  test('carries the levels last set into a later SetCommState', () => {
    const { dcb } = dcbFor()
    setLineControl(dcb, { dtr: false, rts: true }, false)
    const flags = new DataView(dcb.buffer).getUint32(DCB.flags, true)
    expect((flags >> fDtrControlShift) & 0b11).toBe(0)
    expect((flags >> fRtsControlShift) & 0b11).toBe(1)
    expect(flags & fBinary).toBe(fBinary) // other flags untouched
  })

  test('initialLines mirrors hupcl', () => {
    expect(initialLines({ hupcl: true })).toEqual({ dtr: true, rts: true })
    expect(initialLines({ hupcl: false })).toEqual({ dtr: false, rts: false })
  })
})

test('checkLineSettings rejects what a DCB cannot express', () => {
  const check = (options: Pick<ResolvedOpenOptions, 'dataBits' | 'stopBits'>) => () => checkLineSettings(options)
  expect(errorCode(check({ dataBits: 8, stopBits: 1.5 }))).toBe('UNSUPPORTED')
  expect(errorCode(check({ dataBits: 5, stopBits: 2 }))).toBe('UNSUPPORTED')
  expect(errorCode(check({ dataBits: 5, stopBits: 1.5 }))).toBeUndefined()
  expect(errorCode(check({ dataBits: 8, stopBits: 2 }))).toBeUndefined()
})

test('commTimeouts lays out five DWORDs', () => {
  const view = new DataView(commTimeouts(0xffffffff, 1, 2, 3, 4).buffer)
  expect([0, 4, 8, 12, 16].map((offset) => view.getUint32(offset, true))).toEqual([0xffffffff, 1, 2, 3, 4])
})

test('struct sizes and offsets match the 64-bit Windows ABI', () => {
  expect(DCB.size).toBe(28)
  expect(COMSTAT.size).toBe(12)
  expect(OVERLAPPED.size).toBe(32)
  expect(OVERLAPPED.hEvent).toBe(24)
  expect(SP_DEVINFO_DATA.size).toBe(32)
  expect(SP_DEVINFO_DATA.DevInst).toBe(20)
  expect(GENERIC_READ_WRITE).toBe(0xc0000000) // positive: never a negative int32
  // {4d36e978-e325-11ce-bfc1-08002be10318}
  const guid = new DataView(GUID_DEVCLASS_PORTS.buffer)
  expect(guid.getUint32(0, true).toString(16)).toBe('4d36e978')
  expect(guid.getUint16(4, true).toString(16)).toBe('e325')
  expect(guid.getUint16(6, true).toString(16)).toBe('11ce')
})

describe('strings', () => {
  test('wide() is null-terminated UTF-16LE', () => {
    expect([...wide('COM3')]).toEqual([0x43, 0, 0x4f, 0, 0x4d, 0, 0x33, 0, 0, 0])
  })

  test('fromWide() stops at the first NUL, ignoring a stale tail', () => {
    const buffer = wide('USB Serial Port (COM3) and stale text')
    buffer.set(wide('USB Serial Port'))
    expect(fromWide(buffer)).toBe('USB Serial Port')
    expect(fromWide(wide('한글 장치'))).toBe('한글 장치')
  })

  test('devicePath() adds the \\\\.\\ prefix once', () => {
    expect(devicePath('COM3')).toBe('\\\\.\\COM3')
    expect(devicePath('COM12')).toBe('\\\\.\\COM12')
    expect(devicePath('\\\\.\\COM12')).toBe('\\\\.\\COM12')
  })
})

describe('parseInstanceId', () => {
  test('a USB device with a real serial number', () => {
    expect(parseInstanceId('USB\\VID_10C4&PID_EA60\\0001')).toEqual({
      vendorId: '10c4',
      productId: 'ea60',
      serialNumber: '0001',
    })
  })

  test('a Windows-generated last segment is not a serial number', () => {
    expect(parseInstanceId('USB\\VID_1A86&PID_7523\\5&2A7B3C4D&0&3')).toEqual({ vendorId: '1a86', productId: '7523' })
  })

  test('an interface of a composite device has no serial of its own', () => {
    expect(parseInstanceId('USB\\VID_2341&PID_8036&MI_00\\6&3A4B5C6D&0&0000')).toEqual({
      vendorId: '2341',
      productId: '8036',
    })
  })

  test('the FTDI driver encodes the serial after the PID, plus a port letter', () => {
    expect(parseInstanceId('FTDIBUS\\VID_0403+PID_6001+A50285BIA\\0000')).toEqual({
      vendorId: '0403',
      productId: '6001',
      serialNumber: 'A50285BI',
    })
  })

  test('a built-in port has no USB identity', () => {
    expect(parseInstanceId('ACPI\\PNP0501\\1')).toEqual({})
  })
})

describe('error mapping', () => {
  test('open failures', () => {
    expect(openErrorCode(ERROR_FILE_NOT_FOUND)).toBe('NOT_FOUND')
    expect(openErrorCode(ERROR_ACCESS_DENIED)).toBe('BUSY')
    expect(openErrorCode(ERROR_SHARING_VIOLATION)).toBe('BUSY')
    expect(openErrorCode(ERROR_INVALID_PARAMETER)).toBe('IO')
  })

  test('I/O failures on a vanished device', () => {
    for (const error of [ERROR_GEN_FAILURE, ERROR_OPERATION_ABORTED, ERROR_DEVICE_NOT_CONNECTED, ERROR_ACCESS_DENIED]) {
      expect(ioErrorCode(error)).toBe('DISCONNECTED')
    }
    expect(ioErrorCode(ERROR_INVALID_PARAMETER)).toBe('IO')
  })

  test('validHandle() rejects NULL and INVALID_HANDLE_VALUE in every form', () => {
    expect(validHandle(null)).toBe(false)
    expect(validHandle(0 as never)).toBe(false)
    expect(validHandle(-1n)).toBe(false)
    expect(validHandle(18446744073709552000 as never)).toBe(false)
    expect(validHandle(0x1a4 as never)).toBe(true)
    expect(validHandle(1670000000000 as never)).toBe(true)
  })
})
