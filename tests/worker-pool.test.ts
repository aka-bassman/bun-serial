// BlockingCallPool on its own, with a worker that blocks its thread the way
// a native call would. Runs everywhere.

import { describe, expect, test } from 'bun:test'
import { isSerialPortError } from '../src/errors.js'
import { BlockingCallPool } from '../src/internal/worker-pool.js'

// Holds its thread for `ms`, then replies with `code`.
const BLOCKING_WORKER = `
self.onmessage = ({ data: { id, ms, code } }) => {
  const end = Date.now() + ms
  while (Date.now() < end) {}
  postMessage({ id, code })
}
`

describe('BlockingCallPool', () => {
  test('run() resolves with the call’s code', async () => {
    const pool = new BlockingCallPool(BLOCKING_WORKER)
    expect(await pool.run({ ms: 0, code: 0 }).result).toBe(0)
    expect(await pool.run({ ms: 10, code: 5 }).result).toBe(5)
  })

  test('abandon() stops waiting at once with CANCELED', async () => {
    const pool = new BlockingCallPool(BLOCKING_WORKER)
    const call = pool.run({ ms: 2000, code: 0 })
    const started = performance.now()
    call.abandon()
    const error = await call.result.catch((err: unknown) => err)
    expect(isSerialPortError(error, 'CANCELED')).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('abandon() after the reply leaves the worker to serve later calls', async () => {
    const pool = new BlockingCallPool(BLOCKING_WORKER, 1)
    const call = pool.run({ ms: 0, code: 4 })
    expect(await call.result).toBe(4)
    call.abandon()
    expect(await pool.run({ ms: 0, code: 6 }).result).toBe(6)
  })

  test('a lease runs its calls in the order they were posted', async () => {
    const pool = new BlockingCallPool(BLOCKING_WORKER)
    const queue = pool.lease()
    const order: number[] = []
    const slow = queue.run({ ms: 200, code: 1 }).then((code) => order.push(code))
    const quick = queue.run({ ms: 0, code: 2 }).then((code) => order.push(code))
    queue.release()
    await Promise.all([slow, quick])
    expect(order).toEqual([1, 2])
  })

  test('a released lease takes no more calls, but finishes those it has', async () => {
    const pool = new BlockingCallPool(BLOCKING_WORKER)
    const queue = pool.lease()
    const pending = queue.run({ ms: 50, code: 7 })
    queue.release()
    expect(isSerialPortError(await queue.run({ ms: 0, code: 0 }).catch((err: unknown) => err), 'IO')).toBe(true)
    expect(await pending).toBe(7)
  })

  test('calls on separate leases do not wait for each other', async () => {
    const pool = new BlockingCallPool(BLOCKING_WORKER)
    const first = pool.lease()
    const second = pool.lease()
    const started = performance.now()
    const blocked = first.run({ ms: 1000, code: 0 })
    expect(await second.run({ ms: 0, code: 3 })).toBe(3)
    expect(performance.now() - started).toBeLessThan(800)
    first.release()
    second.release()
    await blocked
  })
})
