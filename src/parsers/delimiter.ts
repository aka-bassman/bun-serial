// Splits incoming bytes on a delimiter — one byte or a sequence — and emits
// each message, without the delimiter unless includeDelimiter is set.

import { EventEmitter } from 'node:events'
import { invalidArgument, SerialPortError } from '../errors.js'
import type { Parser, ParserEvents } from './types.js'

export interface DelimiterParserOptions {
  /** A byte, a string (UTF-8 encoded), or a byte sequence. Must not be empty. @default 0x0a */
  delimiter?: number | string | ArrayLike<number>
  /** Keep the delimiter at the end of each message. @default false */
  includeDelimiter?: boolean
}

const textEncoder = new TextEncoder()

export class DelimiterParser extends EventEmitter<ParserEvents<Uint8Array>> implements Parser {
  readonly #delimiter: Uint8Array
  readonly #includeDelimiter: boolean
  #buffer = new Uint8Array(256)
  #length = 0
  // No delimiter starts before this index, so the next search can skip it.
  #searchFrom = 0

  constructor(options: DelimiterParserOptions = {}) {
    super()
    this.#delimiter = toDelimiter(options.delimiter ?? 0x0a)
    const includeDelimiter = options.includeDelimiter ?? false
    if (typeof includeDelimiter !== 'boolean') throw invalidArgument('includeDelimiter', includeDelimiter)
    this.#includeDelimiter = includeDelimiter
  }

  push(chunk: Uint8Array): void {
    this.#append(chunk)
    const delimiter = this.#delimiter
    const messages: Uint8Array[] = []
    let start = 0
    for (;;) {
      const index = indexOf(this.#buffer, this.#length, delimiter, Math.max(start, this.#searchFrom))
      if (index === -1) break
      const end = this.#includeDelimiter ? index + delimiter.length : index
      messages.push(this.#buffer.slice(start, end))
      start = index + delimiter.length
    }
    if (start > 0) {
      this.#buffer.copyWithin(0, start, this.#length)
      this.#length -= start
    }
    // A delimiter could still begin in the last few bytes and finish in the next chunk.
    this.#searchFrom = Math.max(0, this.#length - delimiter.length + 1)

    // Emit only once the buffer is consistent, so a throwing listener can't corrupt it.
    for (const message of messages) this.emit('data', message)
  }

  /** Drop any buffered partial message. */
  reset(): void {
    this.#length = 0
    this.#searchFrom = 0
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

export function delimiterParser(options?: DelimiterParserOptions): DelimiterParser {
  return new DelimiterParser(options)
}

function toDelimiter(value: number | string | ArrayLike<number>): Uint8Array {
  let bytes: Uint8Array
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw invalidArgument('delimiter', value)
    bytes = Uint8Array.of(value)
  } else if (typeof value === 'string') {
    bytes = textEncoder.encode(value)
  } else if (typeof value === 'object' && value !== null && typeof value.length === 'number') {
    const values = Array.from(value)
    if (values.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw invalidArgument('delimiter', values)
    }
    bytes = Uint8Array.from(values)
  } else {
    throw invalidArgument('delimiter', value)
  }
  if (bytes.length === 0) throw new SerialPortError('INVALID_ARGUMENT', 'delimiter must not be empty')
  return bytes
}

function indexOf(haystack: Uint8Array, length: number, needle: Uint8Array, from: number): number {
  if (needle.length === 1) return haystack.subarray(0, length).indexOf(needle[0]!, from)
  const last = length - needle.length
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}
