// Like the delimiter parser, but splits on a line ending and emits strings.

import { EventEmitter } from 'node:events'
import { invalidArgument } from '../errors.js'
import { emitEach, throwErrors } from '../internal/emit.js'
import { DelimiterParser } from './delimiter.js'
import type { Parser, ParserEvents } from './types.js'

type Encoding = NonNullable<ConstructorParameters<typeof TextDecoder>[0]>

export interface ReadlineParserOptions {
  /** @default '\n' */
  delimiter?: string
  /** Any TextDecoder label. @default 'utf-8' */
  encoding?: Encoding
}

export class ReadlineParser extends EventEmitter<ParserEvents<string>> implements Parser {
  readonly #lines: DelimiterParser

  constructor(options: ReadlineParserOptions = {}) {
    super()
    const delimiter = options.delimiter ?? '\n'
    if (typeof delimiter !== 'string') throw invalidArgument('delimiter', delimiter)
    const decoder = createDecoder(options.encoding ?? 'utf-8')
    this.#lines = new DelimiterParser({ delimiter })
    this.#lines.on('data', (bytes) => throwErrors(emitEach(this, 'data', [decoder.decode(bytes)])))
  }

  push(chunk: Uint8Array): void {
    this.#lines.push(chunk)
  }

  /** Drop any buffered partial line. */
  reset(): void {
    this.#lines.reset()
  }
}

export function readlineParser(options?: ReadlineParserOptions): ReadlineParser {
  return new ReadlineParser(options)
}

function createDecoder(encoding: Encoding): TextDecoder {
  try {
    return new TextDecoder(encoding)
  } catch {
    throw invalidArgument('encoding', encoding)
  }
}
