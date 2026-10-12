// POSIX binding (Linux, macOS): termios through libc via bun:ffi. Nothing is
// loaded until the first open() or list().

import type { Binding } from '../types.js'
import { darwinCapabilities, linuxCapabilities } from './capabilities.js'
import { darwinConstants, linuxConstants } from './constants.js'
import { listDarwin } from './list-darwin.js'
import { listLinux } from './list-linux.js'
import { PosixPort } from './port.js'

export function createPosixBinding(platform: 'linux' | 'darwin'): Binding {
  const constants = platform === 'linux' ? linuxConstants : darwinConstants
  return {
    name: `posix-${platform}`,
    capabilities: platform === 'linux' ? linuxCapabilities : darwinCapabilities,
    list: () => (platform === 'linux' ? listLinux() : listDarwin()),
    open: async (path, options) => PosixPort.open(path, options, constants),
  }
}
