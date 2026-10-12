// Tracks whether an open port has been closed, and lets its pending waits
// wake up as soon as it is. Every binding loop re-checks `closed` after each
// await, before touching the OS handle again — that is what keeps a closed
// (and possibly reused) fd or HANDLE from being read or written.

import { canceledError } from '../errors.js'

// The longest delay setTimeout takes; anything longer would fire at once.
const MAX_TIMEOUT_MS = 2 ** 31 - 1

export class PortLifetime {
  #closed = false
  readonly #wakers = new Set<() => void>()

  get closed(): boolean {
    return this.#closed
  }

  end(): void {
    this.#closed = true
    for (const wake of [...this.#wakers]) wake()
  }

  /**
   * Wait `ms` — Infinity for no limit — or less if `until` settles or the
   * port closes meanwhile (the caller re-checks). Rejects CANCELED if
   * `signal` aborts first.
   */
  wait(ms: number, signal?: AbortSignal, until?: Promise<unknown>): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(canceledError())
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        clearTimeout(timer)
        this.#wakers.delete(wake)
        signal?.removeEventListener('abort', onAbort)
      }
      const wake = () => {
        finish()
        resolve()
      }
      const onAbort = () => {
        finish()
        reject(canceledError())
      }
      // Past what a timer can be set for, wake early; the caller waits again.
      if (ms !== Infinity) timer = setTimeout(wake, Math.min(ms, MAX_TIMEOUT_MS))
      this.#wakers.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
      until?.then(wake, wake)
    })
  }
}
