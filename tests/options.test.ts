import { describe, expect, test } from 'bun:test'
import { darwinCapabilities, linuxCapabilities } from '../src/bindings/posix/capabilities.js'
import { win32Capabilities } from '../src/bindings/win32/capabilities.js'
import type { BindingCapabilities } from '../src/bindings/types.js'
import { resolveOpenOptions, validateBaudRate } from '../src/options.js'
import { errorCode } from './helpers/errors.js'

describe('resolveOpenOptions', () => {
  test('fills in defaults', () => {
    expect(resolveOpenOptions({ baudRate: 115200 }, linuxCapabilities)).toEqual({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
      xany: false,
      hupcl: true,
      lock: true,
      pollInterval: 1,
      writeTimeout: 1000,
    })
  })

  test('the result is frozen', () => {
    expect(Object.isFrozen(resolveOpenOptions({ baudRate: 9600 }, linuxCapabilities))).toBe(true)
  })

  test('malformed values are INVALID_ARGUMENT', () => {
    const resolve = (options: object) => () => resolveOpenOptions({ baudRate: 9600, ...options }, linuxCapabilities)
    expect(errorCode(resolve({ baudRate: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ baudRate: -9600 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ baudRate: 115200.5 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ baudRate: undefined }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ dataBits: 9 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ stopBits: 3 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ parity: 'sometimes' }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ pollInterval: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ writeTimeout: -1 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(resolve({ writeTimeout: Number.NaN }))).toBe('INVALID_ARGUMENT')
  })

  test('non-boolean flags are INVALID_ARGUMENT, not truthy', () => {
    for (const flag of ['rtscts', 'xon', 'xoff', 'xany', 'hupcl', 'lock']) {
      expect(errorCode(() => resolveOpenOptions({ baudRate: 9600, [flag]: 'yes' }, linuxCapabilities))).toBe(
        'INVALID_ARGUMENT',
      )
    }
  })

  test('writeTimeout accepts Infinity', () => {
    expect(resolveOpenOptions({ baudRate: 9600, writeTimeout: Infinity }, linuxCapabilities).writeTimeout).toBe(Infinity)
  })

  test('values the platform cannot honor are UNSUPPORTED, not ignored', () => {
    expect(errorCode(() => resolveOpenOptions({ baudRate: 9600, parity: 'mark' }, darwinCapabilities))).toBe('UNSUPPORTED')
    expect(errorCode(() => resolveOpenOptions({ baudRate: 9600, stopBits: 1.5 }, linuxCapabilities))).toBe('UNSUPPORTED')
    expect(errorCode(() => resolveOpenOptions({ baudRate: 9600, lock: false }, win32Capabilities))).toBe('UNSUPPORTED')
    expect(errorCode(() => resolveOpenOptions({ baudRate: 9600, xany: true }, win32Capabilities))).toBe('UNSUPPORTED')
  })

  test('each platform accepts what it declares', () => {
    expect(resolveOpenOptions({ baudRate: 9600, parity: 'space' }, linuxCapabilities).parity).toBe('space')
    expect(resolveOpenOptions({ baudRate: 9600, stopBits: 1.5, dataBits: 5 }, win32Capabilities).stopBits).toBe(1.5)
    expect(resolveOpenOptions({ baudRate: 250000 }, darwinCapabilities).baudRate).toBe(250000)
  })
})

describe('validateBaudRate', () => {
  const strict: BindingCapabilities = { ...linuxCapabilities, customBaudRates: false }

  test('a binding without custom rates only takes the classic table', () => {
    expect(validateBaudRate(115200, strict)).toBe(115200)
    expect(errorCode(() => validateBaudRate(250000, strict))).toBe('UNSUPPORTED')
  })
})
