// Windows binding: the kernel32 serial API through bun:ffi, with overlapped
// I/O so nothing waits on the device while blocking the event loop. Nothing
// is loaded until the first open() or list().

import type { Binding } from '../types.js'
import { win32Capabilities } from './capabilities.js'
import { listWindows } from './list.js'
import { Win32Port, type Win32Api } from './port.js'

/** The Windows binding; `api` replaces the OS for tests. */
export function createWin32Binding(api?: Win32Api): Binding {
  return {
    name: 'win32',
    capabilities: win32Capabilities,
    list: () => listWindows(),
    open: async (path, options) => Win32Port.open(path, options, api),
  }
}

export const win32Binding: Binding = createWin32Binding()
