import { invalidArgument } from '../errors.js'

/** Accepted by write(). Strings are UTF-8 encoded; arrays must hold byte values. */
export type WriteData = string | Uint8Array | ArrayBufferLike | ArrayBufferView | readonly number[]

const textEncoder = new TextEncoder()

export function toBytes(data: WriteData): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (typeof data === 'string') return textEncoder.encode(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    for (const value of data) {
      if (!Number.isInteger(value) || value < 0 || value > 255) throw invalidArgument('byte in write data', value)
    }
    return Uint8Array.from(data)
  }
  throw invalidArgument('write data', data)
}

/**
 * Bytes for a write that may sit in a queue or span several syscalls: callers
 * can reuse their buffer as soon as write() returns, so views of caller memory
 * are copied. Strings and arrays already produce fresh bytes.
 */
export function snapshotBytes(data: WriteData): Uint8Array {
  const bytes = toBytes(data)
  return typeof data === 'string' || Array.isArray(data) ? bytes : bytes.slice()
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
