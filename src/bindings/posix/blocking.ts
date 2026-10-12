// Calls that can hold the calling thread for as long as the driver likes run
// on worker threads: tcdrain — seconds at low baud rates, forever if flow
// control never releases — and on macOS also tcflush and close(2), which its
// serial drivers make wait for a tcdrain in progress.

import { BlockingCallPool, type BlockingCall, type CallQueue } from '../../internal/worker-pool.js'
import type { PosixConstants } from './constants.js'

const WORKER = `
import { dlopen, FFIType, read } from 'bun:ffi'
let lib
self.onmessage = ({ data: { id, call, fd, queue, libc, errnoSymbol, EINTR } }) => {
  lib ??= dlopen(libc, {
    tcdrain: { args: [FFIType.i32], returns: FFIType.i32 },
    tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    [errnoSymbol]: { args: [], returns: FFIType.ptr },
  }).symbols
  let code = 0
  for (;;) {
    const result = call === 'tcdrain' ? lib.tcdrain(fd) : call === 'tcflush' ? lib.tcflush(fd, queue) : lib.close(fd)
    if (result >= 0) break
    code = read.i32(lib[errnoSymbol](), 0)
    // A failed close(2) has still released the fd; another try could close a reused number.
    if (code !== EINTR || call === 'close') break
    code = 0
  }
  postMessage({ id, code })
}
`

const pool = new BlockingCallPool(WORKER)

/** Run tcdrain(fd) on a worker thread; the result is its errno, 0 on success. */
export function drainOffThread(fd: number, libc: string, c: PosixConstants): BlockingCall {
  return pool.run({ call: 'tcdrain', fd, libc, errnoSymbol: c.errnoSymbol, EINTR: c.errno.EINTR })
}

/**
 * A worker thread of one port's own for tcflush and close(2). They run in
 * call order, so a close can never overtake a flush and leave it to hit a
 * reused descriptor. Results are errno values, 0 on success.
 */
export class PortThread {
  readonly #queue: CallQueue = pool.lease()
  readonly #call: Record<string, unknown>

  constructor(fd: number, libc: string, c: PosixConstants) {
    this.#call = { fd, libc, errnoSymbol: c.errnoSymbol, EINTR: c.errno.EINTR }
  }

  flush(queue: number): Promise<number> {
    return this.#queue.run({ ...this.#call, call: 'tcflush', queue })
  }

  /** The last call: the thread goes back to the pool once it returns. */
  close(): Promise<number> {
    const closed = this.#queue.run({ ...this.#call, call: 'close' })
    this.#queue.release()
    return closed
  }
}
