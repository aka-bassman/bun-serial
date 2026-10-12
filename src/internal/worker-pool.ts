// Runs blocking FFI calls — tcdrain, and on macOS tcflush and close — on
// worker threads so the event loop keeps going. Worker source is passed
// inline and loaded from a Blob URL, so it survives bundling and
// `bun build --compile`.
//
// Protocol: the pool posts `{ id, ...request }`; the worker replies
// `{ id, code }`, where `code` is the call's errno / Win32 error, 0 on success.
// A worker handles one message at a time, so calls posted to the same worker
// run one after another, in order.

import { canceledError, SerialPortError } from '../errors.js'

export interface BlockingCall {
  /** Resolves with the call's error code, 0 on success. */
  readonly result: Promise<number>
  /** Stop waiting: `result` rejects CANCELED and the worker is discarded. */
  abandon(): void
}

/** One worker to itself: calls run on it in the order they are posted. */
export interface CallQueue {
  /** Resolves with the call's error code, 0 on success, once the calls posted before it are done. */
  run(request: Record<string, unknown>): Promise<number>
  /** No more calls: the worker goes back to the pool once those posted have returned. */
  release(): void
}

interface Reply {
  id: number
  code: number
}

export class BlockingCallPool {
  readonly #source: string
  readonly #maxIdle: number
  readonly #idle: Worker[] = []
  #url: string | undefined
  #nextId = 1

  constructor(source: string, maxIdle = 2) {
    this.#source = source
    this.#maxIdle = maxIdle
  }

  run(request: Record<string, unknown>): BlockingCall {
    const worker = this.#take()
    const id = this.#nextId++
    let settle!: { resolve: (code: number) => void; reject: (error: SerialPortError) => void }
    const result = new Promise<number>((resolve, reject) => {
      settle = { resolve, reject }
    })

    let settled = false
    const detach = () => {
      settled = true
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent<Reply>) => {
      if (event.data.id !== id) return
      detach()
      this.#giveBack(worker)
      settle.resolve(event.data.code)
    }
    const onError = (event: ErrorEvent) => {
      detach()
      worker.terminate()
      settle.reject(workerFailed(event))
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ ...request, id })

    return {
      result,
      abandon() {
        // Once settled the worker may be back in the pool, serving someone else.
        if (settled) return
        detach()
        // Terminating also keeps the worker from retrying the call on a
        // descriptor or handle the caller is about to close.
        worker.terminate()
        settle.reject(canceledError())
      },
    }
  }

  lease(): CallQueue {
    const worker = this.#take()
    const pending = new Map<number, { resolve: (code: number) => void; reject: (error: SerialPortError) => void }>()
    let released = false
    let failure: SerialPortError | null = null

    const detach = () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent<Reply>) => {
      const call = pending.get(event.data.id)
      if (!call) return
      pending.delete(event.data.id)
      call.resolve(event.data.code)
      if (released && pending.size === 0) {
        detach()
        this.#giveBack(worker)
      }
    }
    const onError = (event: ErrorEvent) => {
      detach()
      worker.terminate()
      failure = workerFailed(event)
      for (const call of pending.values()) call.reject(failure)
      pending.clear()
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)

    return {
      run: (request) => {
        if (failure) return Promise.reject(failure)
        if (released) return Promise.reject(new SerialPortError('IO', 'Call queue already released'))
        const id = this.#nextId++
        const result = new Promise<number>((resolve, reject) => pending.set(id, { resolve, reject }))
        worker.postMessage({ ...request, id })
        return result
      },
      release: () => {
        if (released) return
        released = true
        if (pending.size === 0 && !failure) {
          detach()
          this.#giveBack(worker)
        }
      },
    }
  }

  #take(): Worker {
    return this.#idle.pop() ?? this.#spawn()
  }

  #giveBack(worker: Worker): void {
    if (this.#idle.length < this.#maxIdle) this.#idle.push(worker)
    else worker.terminate()
  }

  #spawn(): Worker {
    this.#url ??= URL.createObjectURL(new Blob([this.#source], { type: 'application/javascript' }))
    const worker = new Worker(this.#url)
    // An idle worker must not keep the process alive; an open port's read loop does that.
    worker.unref()
    return worker
  }
}

function workerFailed(event: ErrorEvent): SerialPortError {
  return new SerialPortError('IO', `Worker failed: ${event.message}`)
}
