// Waiting on Win32 handles without polling, and slow calls off the event loop.
//
// watchHandle(): the system thread pool waits for the handle
// (RegisterWaitForSingleObject) and, once it is signaled, calls a threadsafe
// JSCallback, which Bun runs on this JavaScript thread. A port waiting for
// data then costs no CPU at all, and hears of a completion within a fraction
// of a millisecond.
//
// callOnThread(): FlushFileBuffers and CloseHandle can keep a driver busy for
// a long time — an FTDI adapter takes about 110 ms to close. Both have the
// signature of a thread's start routine, BOOL WINAPI f(HANDLE), so each call
// runs as the whole body of a thread of its own. The thread's exit is watched
// like any other handle, and its exit code is the call's BOOL.

import { FFIType, JSCallback, type Pointer } from 'bun:ffi'
import { canceledError } from '../../errors.js'
import { holdOpen, letGo } from '../../internal/keep-alive.js'
import { kernel32, validHandle, win32Error, type Handle } from './ffi.js'
import { wide } from './structs.js'

const WT_EXECUTEINWAITTHREAD = 0x4
const WT_EXECUTEONLYONCE = 0x8
const INFINITE = 0xffffffff
const WAIT_OBJECT_0 = 0
// UnregisterWaitEx's completion event: INVALID_HANDLE_VALUE waits for a
// callback already under way to return. Ours only queues work for this
// thread, so that never takes long.
const AFTER_CALLBACKS = 0xffffffffffffffffn
const AT_ONCE = 0n
// A thread that makes one call needs little stack; this much is only reserved.
const THREAD_STACK_BYTES = 256n * 1024n
const STACK_SIZE_PARAM_IS_A_RESERVATION = 0x10000
// How long close() waits for a driver to close the handle before moving on.
const CLOSE_WAIT_MS = 1000
// When the thread pool can't take a wait, look again this soon instead.
const FALLBACK_POLL_MS = 1

export interface HandleWatch {
  /**
   * Resolves once the handle is signaled or the watch is stopped — or, if
   * the system could not take the wait, after a moment. Never rejects.
   * Callers check what they were waiting for again.
   */
  readonly done: Promise<void>
  /** Stop watching. Once this returns, the handle may be closed or reused. */
  stop(): void
}

export interface ThreadCall {
  /** Resolves with the call's BOOL: true if it succeeded. */
  readonly result: Promise<boolean>
  /** Stop waiting for it: `result` rejects CANCELED. The call itself runs on. */
  abandon(): void
}

// Watches by id. The id is the context the thread pool hands the callback.
const watches = new Map<number, () => void>()
let nextId = 1
let callback: JSCallback | undefined

// WAITORTIMERCALLBACK(context, timedOut), run on this thread by Bun.
function signaled(context: number): void {
  watches.get(context)?.()
}

/** Learn that `handle` is signaled — an event, a thread — without polling. */
export function watchHandle(handle: Handle): HandleWatch {
  const k = kernel32()
  callback ??= new JSCallback(signaled, { args: [FFIType.ptr, FFIType.u8], returns: FFIType.void, threadsafe: true })
  let resolve!: () => void
  const done = new Promise<void>((settle) => (resolve = settle))

  const id = nextId++
  const registered = new BigUint64Array(1)
  const flags = WT_EXECUTEONLYONCE | WT_EXECUTEINWAITTHREAD
  if (!k.RegisterWaitForSingleObject(registered, handle, callback.ptr, id as Pointer, INFINITE, flags)) {
    const timer = setTimeout(resolve, FALLBACK_POLL_MS)
    return {
      done,
      stop() {
        clearTimeout(timer)
        resolve()
      },
    }
  }

  const wait = Number(registered[0]) as Pointer
  let watching = true
  const finish = (completion: bigint) => {
    if (!watching) return
    watching = false
    watches.delete(id)
    k.UnregisterWaitEx(wait, completion)
    letGo()
    resolve()
  }
  watches.set(id, () => finish(AT_ONCE))
  // The thread pool's waits don't count for Bun's event loop.
  holdOpen()
  return { done, stop: () => finish(AFTER_CALLBACKS) }
}

// Where the calls a thread can run live, looked up once.
let entryPoints: Record<'FlushFileBuffers' | 'CloseHandle', Pointer> | undefined

function entryPoint(name: 'FlushFileBuffers' | 'CloseHandle'): Pointer {
  if (!entryPoints) {
    const k = kernel32()
    const module = k.GetModuleHandleW(wide('kernel32.dll'))
    const find = (symbol: string): Pointer => {
      const address = k.GetProcAddress(module, new TextEncoder().encode(`${symbol}\0`))
      if (!validHandle(address)) throw win32Error('GetProcAddress', k.GetLastError())
      return address
    }
    entryPoints = { FlushFileBuffers: find('FlushFileBuffers'), CloseHandle: find('CloseHandle') }
  }
  return entryPoints[name]
}

/**
 * Run FlushFileBuffers(handle) or CloseHandle(handle) on a thread of its own.
 * Throws if no thread can be had.
 */
export function callOnThread(name: 'FlushFileBuffers' | 'CloseHandle', handle: Handle): ThreadCall {
  const k = kernel32()
  const thread = k.CreateThread(null, THREAD_STACK_BYTES, entryPoint(name), handle, STACK_SIZE_PARAM_IS_A_RESERVATION, null)
  if (!validHandle(thread)) throw win32Error('CreateThread', k.GetLastError())
  let watch: HandleWatch | null = null
  let abandoned = false
  const result = (async () => {
    try {
      while (k.WaitForSingleObject(thread, 0) !== WAIT_OBJECT_0) {
        watch = watchHandle(thread)
        await watch.done
        if (abandoned) throw canceledError()
      }
      const code = new Uint32Array(1)
      k.GetExitCodeThread(thread, code)
      return code[0] !== 0
    } finally {
      watch?.stop()
      // The thread runs on if it hasn't returned; this only lets go of it.
      k.CloseHandle(thread)
    }
  })()
  return {
    result,
    abandon() {
      abandoned = true
      watch?.stop()
    },
  }
}

/**
 * CloseHandle(handle) off the event loop, waiting at most CLOSE_WAIT_MS for
 * the driver. Never rejects.
 */
export async function closeOnThread(handle: Handle): Promise<void> {
  let call: ThreadCall
  try {
    call = callOnThread('CloseHandle', handle)
  } catch {
    kernel32().CloseHandle(handle) // no thread to be had: close it here
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_WAIT_MS)))
  await Promise.race([call.result.catch(() => false), waited])
  clearTimeout(timer)
  call.abandon()
  await call.result.catch(() => false)
}
