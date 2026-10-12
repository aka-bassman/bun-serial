// Kept apart from the FFI code so any OS can import it (option validation,
// tests, docs) without loading libc.

import type { BindingCapabilities } from '../types.js'

export const linuxCapabilities: BindingCapabilities = {
  dataBits: [5, 6, 7, 8],
  stopBits: [1, 2],
  parity: ['none', 'even', 'odd', 'mark', 'space'], // mark/space via CMSPAR
  customBaudRates: true, // termios2 + BOTHER
  xany: true,
  sharedAccess: true, // lock: false skips flock
}

export const darwinCapabilities: BindingCapabilities = {
  dataBits: [5, 6, 7, 8],
  stopBits: [1, 2],
  parity: ['none', 'even', 'odd'], // no CMSPAR on macOS
  customBaudRates: true, // IOSSIOSPEED
  xany: true,
  sharedAccess: true,
}
