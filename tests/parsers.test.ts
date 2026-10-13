import { describe, expect, test } from 'bun:test'
import { byteLengthParser, delimiterParser, readlineParser } from '../src/parsers/index.js'
import { errorCode } from './helpers/errors.js'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

function collect<T>(parser: { on(event: 'data', listener: (message: T) => void): unknown }): T[] {
  const messages: T[] = []
  parser.on('data', (message) => messages.push(message))
  return messages
}

describe('delimiterParser', () => {
  test('splits on a delimiter byte', () => {
    const parser = delimiterParser({ delimiter: 0x0a })
    const messages = collect(parser)
    parser.push(Uint8Array.of(0x41, 0x42, 0x0a, 0x43, 0x0a))
    expect(messages.map((m) => [...m])).toEqual([[0x41, 0x42], [0x43]])
  })

  test('handles messages split across chunks', () => {
    const parser = delimiterParser({ delimiter: '\n' })
    const messages = collect(parser)
    parser.push(encode('hel'))
    parser.push(encode('lo\nwor'))
    parser.push(encode('ld\n'))
    expect(messages.map(decode)).toEqual(['hello', 'world'])
  })

  test('handles a multi-byte delimiter split across chunks', () => {
    const parser = delimiterParser({ delimiter: [0x0d, 0x0a] })
    const messages = collect(parser)
    parser.push(encode('A\r'))
    parser.push(encode('\nB\r\n'))
    expect(messages.map(decode)).toEqual(['A', 'B'])
  })

  test('includeDelimiter keeps it on each message', () => {
    const parser = delimiterParser({ delimiter: 0x0a, includeDelimiter: true })
    const messages = collect(parser)
    parser.push(encode('A\nB\n'))
    expect(messages.map(decode)).toEqual(['A\n', 'B\n'])
  })

  test('consecutive delimiters emit empty messages', () => {
    const parser = delimiterParser({ delimiter: '\n' })
    const messages = collect(parser)
    parser.push(encode('\nhello\n\n'))
    expect(messages.map(decode)).toEqual(['', 'hello', ''])
  })

  test('a long message arriving byte by byte is found once complete', () => {
    const parser = delimiterParser({ delimiter: '\r\n' })
    const messages = collect(parser)
    const text = 'x'.repeat(5000)
    for (const byte of encode(`${text}\r\n`)) parser.push(Uint8Array.of(byte))
    expect(messages.map(decode)).toEqual([text])
  })

  test('a throwing listener does not corrupt the buffer', () => {
    const parser = delimiterParser()
    let calls = 0
    parser.on('data', () => {
      calls++
      if (calls === 1) throw new Error('listener failed')
    })
    expect(() => parser.push(encode('a\n'))).toThrow('listener failed')
    const messages = collect(parser)
    parser.push(encode('b\n'))
    expect(messages.map(decode)).toEqual(['b'])
  })

  test('a throwing listener costs no message and no other listener, then push() rethrows', () => {
    const parser = delimiterParser()
    parser.on('data', (message) => {
      if (decode(message) === 'a') throw new Error('listener failed')
    })
    const messages = collect(parser)
    expect(() => parser.push(encode('a\nb\nc\n'))).toThrow('listener failed')
    expect(messages.map(decode)).toEqual(['a', 'b', 'c'])
  })

  test('several throwing listeners are rethrown together as an AggregateError', () => {
    const parser = delimiterParser()
    parser.on('data', (message) => {
      throw new Error(`failed on ${decode(message)}`)
    })
    let thrown: unknown
    try {
      parser.push(encode('a\nb\n'))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors.map((err: Error) => err.message)).toEqual(['failed on a', 'failed on b'])
  })

  test('reset() drops a buffered partial message', () => {
    const parser = delimiterParser()
    const messages = collect(parser)
    parser.push(encode('partial'))
    parser.reset()
    parser.push(encode('whole\n'))
    expect(messages.map(decode)).toEqual(['whole'])
  })

  test('rejects empty and malformed delimiters', () => {
    expect(errorCode(() => delimiterParser({ delimiter: '' }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => delimiterParser({ delimiter: [] }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => delimiterParser({ delimiter: 256 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => delimiterParser({ delimiter: [1, 300] }))).toBe('INVALID_ARGUMENT')
  })
})

describe('byteLengthParser', () => {
  test('emits fixed-size chunks and keeps the remainder', () => {
    const parser = byteLengthParser({ length: 3 })
    const chunks = collect(parser)
    parser.push(Uint8Array.of(1, 2, 3, 4, 5, 6, 7))
    expect(chunks.map((c) => [...c])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
    parser.push(Uint8Array.of(8, 9))
    expect(chunks.map((c) => [...c])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ])
  })

  test('assembles a chunk across pushes', () => {
    const parser = byteLengthParser({ length: 4 })
    const chunks = collect(parser)
    parser.push(Uint8Array.of(1, 2))
    parser.push(Uint8Array.of(3, 4, 5))
    expect(chunks.map((c) => [...c])).toEqual([[1, 2, 3, 4]])
  })

  test('a throwing listener costs no chunk, then push() rethrows', () => {
    const parser = byteLengthParser({ length: 1 })
    parser.once('data', () => {
      throw new Error('listener failed')
    })
    const messages = collect(parser)
    expect(() => parser.push(encode('ab'))).toThrow('listener failed')
    expect(messages.map(decode)).toEqual(['a', 'b'])
  })

  test('rejects lengths below one', () => {
    expect(errorCode(() => byteLengthParser({ length: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => byteLengthParser({ length: 1.5 }))).toBe('INVALID_ARGUMENT')
  })
})

describe('readlineParser', () => {
  test('emits strings', () => {
    const parser = readlineParser()
    const lines = collect(parser)
    parser.push(encode('hello\nworld\n'))
    expect(lines).toEqual(['hello', 'world'])
  })

  test('takes a custom delimiter', () => {
    const parser = readlineParser({ delimiter: '\r\n' })
    const lines = collect(parser)
    parser.push(encode('line1\r\nline2\r\n'))
    expect(lines).toEqual(['line1', 'line2'])
  })

  test('preserves blank lines and multi-byte characters', () => {
    const parser = readlineParser()
    const lines = collect(parser)
    const bytes = encode('\n안녕\n\n')
    parser.push(bytes.subarray(0, 3)) // splits the first character
    parser.push(bytes.subarray(3))
    expect(lines).toEqual(['', '안녕', ''])
  })

  test('a throwing listener costs no line and no other listener, then push() rethrows', () => {
    const parser = readlineParser()
    parser.once('data', () => {
      throw new Error('listener failed')
    })
    const lines = collect(parser)
    expect(() => parser.push(encode('one\ntwo\n'))).toThrow('listener failed')
    expect(lines).toEqual(['one', 'two'])
  })

  test('removeListener detaches a listener', () => {
    const parser = readlineParser()
    const lines: string[] = []
    const listener = (line: string) => lines.push(line)
    parser.on('data', listener)
    parser.removeListener('data', listener)
    parser.push(encode('hello\n'))
    expect(lines).toEqual([])
  })

  test('rejects an unknown encoding', () => {
    // @ts-expect-error not a TextDecoder label
    expect(errorCode(() => readlineParser({ encoding: 'klingon' }))).toBe('INVALID_ARGUMENT')
  })
})
