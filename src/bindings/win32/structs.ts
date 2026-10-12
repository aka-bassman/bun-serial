// Struct packing and string handling for the Windows binding. Pure — no FFI —
// so it is unit-tested on every OS.

import { SerialPortError } from '../../errors.js'
import type { ResolvedOpenOptions } from '../../options.js'
import {
  DCB,
  DTR_CONTROL_DISABLE,
  DTR_CONTROL_ENABLE,
  EVENPARITY,
  fBinary,
  fDtrControlShift,
  fInX,
  fOutX,
  fOutxCtsFlow,
  fParity,
  fRtsControlShift,
  fTXContinueOnXoff,
  MARKPARITY,
  NOPARITY,
  ODDPARITY,
  ONE5STOPBITS,
  ONESTOPBIT,
  RTS_CONTROL_DISABLE,
  RTS_CONTROL_ENABLE,
  RTS_CONTROL_HANDSHAKE,
  SPACEPARITY,
  TWOSTOPBITS,
  XOFF,
  XON,
} from './constants.js'

type LineOptions = Pick<
  ResolvedOpenOptions,
  'baudRate' | 'dataBits' | 'stopBits' | 'parity' | 'rtscts' | 'xon' | 'xoff' | 'hupcl'
>

const PARITY_CODES = { none: NOPARITY, odd: ODDPARITY, even: EVENPARITY, mark: MARKPARITY, space: SPACEPARITY }
const STOP_BIT_CODES = { 1: ONESTOPBIT, 1.5: ONE5STOPBITS, 2: TWOSTOPBITS }

/** Reject combinations a DCB can't express, before any handle is opened. */
export function checkLineSettings(options: Pick<ResolvedOpenOptions, 'dataBits' | 'stopBits'>): void {
  if (options.stopBits === 1.5 && options.dataBits !== 5) {
    throw new SerialPortError('UNSUPPORTED', '1.5 stop bits needs 5 data bits on Windows')
  }
  if (options.stopBits === 2 && options.dataBits === 5) {
    throw new SerialPortError('UNSUPPORTED', '5 data bits with 2 stop bits is not supported on Windows')
  }
}

/**
 * Configure the DCB that GetCommState() filled. Every flag is set explicitly
 * rather than inherited: a previous user may have left fAbortOnError on, which
 * makes the driver fail all I/O after a line error until ClearCommError runs.
 */
export function configureDcb(dcb: Uint8Array, options: LineOptions): void {
  const view = new DataView(dcb.buffer, dcb.byteOffset, dcb.byteLength)
  view.setUint32(DCB.DCBlength, DCB.size, true)
  view.setUint32(DCB.BaudRate, options.baudRate, true)

  // fBinary is mandatory. fTXContinueOnXoff keeps our output flowing after we
  // send XOFF, matching IXOFF on POSIX.
  let flags = fBinary | fTXContinueOnXoff
  if (options.parity !== 'none') flags |= fParity
  if (options.rtscts) flags |= fOutxCtsFlow
  if (options.xon) flags |= fOutX
  if (options.xoff) flags |= fInX
  view.setUint32(DCB.flags, flags >>> 0, true)
  setLineControl(dcb, initialLines(options), options.rtscts)

  dcb[DCB.ByteSize] = options.dataBits
  dcb[DCB.Parity] = PARITY_CODES[options.parity]
  dcb[DCB.StopBits] = STOP_BIT_CODES[options.stopBits]
  // SetCommState rejects XonChar === XoffChar, which some drivers report by default.
  dcb[DCB.XonChar] = XON
  dcb[DCB.XoffChar] = XOFF
}

export interface LineLevels {
  dtr: boolean
  rts: boolean
}

/**
 * DTR and RTS right after open: both asserted, as on POSIX — or, with
 * hupcl: false, both left down. Windows drivers drop DTR on close whatever the
 * settings, so never raising it is the only way to avoid the edge that resets
 * Arduino-style boards; and DTR down with RTS up is exactly the state that
 * holds an ESP32/ESP8266 auto-reset circuit in reset, so RTS stays down too
 * (node-serialport makes the same choice).
 */
export function initialLines(options: Pick<ResolvedOpenOptions, 'hupcl'>): LineLevels {
  return { dtr: options.hupcl, rts: options.hupcl }
}

/**
 * The DCB's DTR/RTS control fields. SetCommState applies them, so every
 * SetCommState after open must carry the levels last set — or a baud rate
 * change would raise a DTR the caller had lowered, and reset the board.
 */
export function setLineControl(dcb: Uint8Array, lines: LineLevels, rtscts: boolean): void {
  const view = new DataView(dcb.buffer, dcb.byteOffset, dcb.byteLength)
  let flags = view.getUint32(DCB.flags, true)
  flags &= ~((0b11 << fDtrControlShift) | (0b11 << fRtsControlShift))
  flags |= (lines.dtr ? DTR_CONTROL_ENABLE : DTR_CONTROL_DISABLE) << fDtrControlShift
  const rts = rtscts ? RTS_CONTROL_HANDSHAKE : lines.rts ? RTS_CONTROL_ENABLE : RTS_CONTROL_DISABLE
  flags |= rts << fRtsControlShift
  view.setUint32(DCB.flags, flags >>> 0, true)
}

/** struct COMMTIMEOUTS from its five DWORDs, in declaration order. */
export function commTimeouts(
  readInterval: number,
  readTotalMultiplier: number,
  readTotalConstant: number,
  writeTotalMultiplier: number,
  writeTotalConstant: number,
): Uint8Array {
  const bytes = new Uint8Array(20)
  const view = new DataView(bytes.buffer)
  const fields = [readInterval, readTotalMultiplier, readTotalConstant, writeTotalMultiplier, writeTotalConstant]
  fields.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true))
  return bytes
}

/** CreateFileW needs the \\.\ namespace for COM10 and above; it works for every port. */
export function devicePath(path: string): string {
  return path.startsWith('\\\\.\\') || path.startsWith('\\\\?\\') ? path : `\\\\.\\${path}`
}

/** A JS string as a null-terminated UTF-16LE buffer (LPCWSTR). */
export function wide(value: string): Uint8Array {
  const units = new Uint16Array(value.length + 1)
  for (let i = 0; i < value.length; i++) units[i] = value.charCodeAt(i)
  return new Uint8Array(units.buffer)
}

const utf16 = new TextDecoder('utf-16le')

/**
 * Decode UTF-16LE up to the first NUL within `byteLength`. Stopping at the
 * first NUL matters: SetupAPI resolves indirect strings in place and leaves the
 * stale tail of the longer original behind it.
 */
export function fromWide(bytes: Uint8Array, byteLength = bytes.length): string {
  const units = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(Math.min(byteLength, bytes.length) / 2))
  const end = units.indexOf(0)
  return utf16.decode(units.subarray(0, end === -1 ? units.length : end))
}

export interface InstanceIdInfo {
  vendorId?: string
  productId?: string
  serialNumber?: string
}

/**
 * VID, PID and serial number from a device instance ID, e.g.
 * `USB\VID_10C4&PID_EA60\0001` or `FTDIBUS\VID_0403+PID_6001+A50285BIA\0000`.
 * Windows makes up the last segment (it contains '&') for devices without a
 * serial number, and for the interfaces of composite devices — the serial then
 * lives on the parent, which the caller can parse the same way.
 */
export function parseInstanceId(instanceId: string): InstanceIdInfo {
  const info: InstanceIdInfo = {}
  const vid = /VID_([0-9A-F]{4})/i.exec(instanceId)
  const pid = /PID_([0-9A-F]{4})/i.exec(instanceId)
  if (vid) info.vendorId = vid[1]!.toLowerCase()
  if (pid) info.productId = pid[1]!.toLowerCase()

  // The FTDI driver puts the serial after the PID and appends the port letter.
  const ftdi = /^FTDIBUS\\.*\+(.+?)A?\\/i.exec(instanceId)
  if (ftdi) {
    info.serialNumber = ftdi[1]
    return info
  }
  const segments = instanceId.split('\\')
  const last = segments[segments.length - 1] ?? ''
  if (/^USB$/i.test(segments[0] ?? '') && segments.length === 3 && last !== '' && !last.includes('&')) {
    info.serialNumber = last
  }
  return info
}
