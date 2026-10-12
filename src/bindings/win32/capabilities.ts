// Kept apart from the FFI code so any OS can import it (option validation,
// tests, docs) without loading kernel32.

import type { BindingCapabilities } from '../types.js'

export const win32Capabilities: BindingCapabilities = {
  dataBits: [5, 6, 7, 8],
  // DCB rejects 5 data bits with 2 stop bits, and 1.5 stop bits with 6-8 data
  // bits; the binding reports those combinations as UNSUPPORTED at open.
  stopBits: [1, 1.5, 2],
  parity: ['none', 'even', 'odd', 'mark', 'space'],
  customBaudRates: true, // DCB.BaudRate is a plain DWORD; the driver may refuse a rate
  xany: false, // no DCB equivalent
  sharedAccess: false, // CreateFileW on a COM port is always exclusive
}
