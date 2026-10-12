import { isSerialPortError, type SerialErrorCode } from '../../src/errors.js'

/** The SerialPortError code `fn` throws, or undefined if it doesn't throw. */
export function errorCode(fn: () => unknown): SerialErrorCode | undefined {
  try {
    fn()
  } catch (err) {
    if (isSerialPortError(err)) return err.code
    throw err
  }
  return undefined
}

/** The SerialPortError code `promise` rejects with, or 'resolved'. */
export async function rejectionCode(promise: Promise<unknown>): Promise<SerialErrorCode | 'resolved'> {
  try {
    await promise
    return 'resolved'
  } catch (err) {
    if (isSerialPortError(err)) return err.code
    throw err
  }
}
