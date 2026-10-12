// Picks the binding for the running OS. Every binding is importable anywhere —
// native libraries are opened on first use — so this can stay synchronous and
// SerialPort can validate options against capabilities in its constructor.

import { SerialPortError } from '../errors.js'
import { createPosixBinding } from './posix/index.js'
import type { Binding } from './types.js'
import { win32Binding } from './win32/index.js'

let platformBinding: Binding | undefined

export function defaultBinding(): Binding {
  if (platformBinding) return platformBinding
  const platform = process.platform
  switch (platform) {
    case 'linux':
    case 'darwin':
      platformBinding = createPosixBinding(platform)
      break
    case 'win32':
      platformBinding = win32Binding
      break
    default:
      throw new SerialPortError('UNSUPPORTED', `Unsupported platform: ${platform}`)
  }
  return platformBinding
}
