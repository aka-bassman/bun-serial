import { defaultBinding } from './bindings/index.js'
import type { PortInfo } from './bindings/types.js'

/** Serial ports present on this machine, sorted by path. */
export async function list(): Promise<PortInfo[]> {
  return defaultBinding().list()
}
