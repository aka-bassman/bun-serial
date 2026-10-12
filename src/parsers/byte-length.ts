// Emits fixed-size chunks of exactly `length` bytes, buffering any remainder.

import { EventEmitter } from 'node:events'
import { SerialPortError } from '../errors.js'
import type { Parser, ParserEvents } from './types.js'

export interface ByteLengthParserOptions {
  /** Size of each emitted chunk in bytes. @default 1 */
  length?: number
}

export class ByteLengthParser extends EventEmitter<ParserEvents<Uint8Array>> implements Parser {
  readonly #chunkLength: number
  #buffer: Uint8Array
  #length = 0

  constructor(options: ByteLengthParserOptions = {}) {
    super()
    const length = options.length ?? 1
    if (!Number.isInteger(length) || length < 1) {
      throw new SerialPortError('INVALID_ARGUMENT', 'length must be an integer >= 1')
    }
    this.#chunkLength = length
    this.#buffer = new Uint8Array(Math.max(length * 2, 256))
  }

  push(chunk: Uint8Array): void {
    this.#append(chunk)
    const count = Math.floor(this.#length / this.#chunkLength)
    if (count === 0) return

    const chunks: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      const start = i * this.#chunkLength
      chunks.push(this.#buffer.slice(start, start + this.#chunkLength))
    }
    const consumed = count * this.#chunkLength
    this.#buffer.copyWithin(0, consumed, this.#length)
    this.#length -= consumed

    // Emit only once the buffer is consistent, so a throwing listener can't corrupt it.
    for (const piece of chunks) this.emit('data', piece)
  }

  /** Drop any buffered partial chunk. */
  reset(): void {
    this.#length = 0
  }

  #append(chunk: Uint8Array): void {
    const needed = this.#length + chunk.length
    if (needed > this.#buffer.length) {
      let capacity = this.#buffer.length
      while (capacity < needed) capacity *= 2
      const grown = new Uint8Array(capacity)
      grown.set(this.#buffer.subarray(0, this.#length))
      this.#buffer = grown
    }
    this.#buffer.set(chunk, this.#length)
    this.#length = needed
  }
}

export function byteLengthParser(options?: ByteLengthParserOptions): ByteLengthParser {
  return new ByteLengthParser(options)
}
