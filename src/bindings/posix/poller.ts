// Readiness for every open port without polling: one worker thread waits in
// epoll_wait (Linux) or kevent (macOS) for all of them at once. A port arms a
// one-shot wait from this thread — epoll_ctl and kevent reach the waiting
// worker at once, no wake-up needed — and the worker posts back which waits
// fired. An idle port costs no CPU, and readiness is seen within a fraction
// of a millisecond. The worker starts with the first open port and stops
// after the last one closes.

import { dlopen, FFIType } from 'bun:ffi'
import { holdOpen, letGo } from '../../internal/keep-alive.js'
import type { EpollConstants, KqueueConstants, PosixConstants } from './constants.js'
import type { Libc } from './ffi.js'

export type Direction = 'read' | 'write'

export interface ReadyWait {
  /**
   * Resolves once the fd may be ready, or the wait is stopped. Never
   * rejects. Callers try their read or write again.
   */
  readonly done: Promise<void>
  stop(): void
}

// What the worker reports for each fired wait: bit 1 when reading may go
// ahead, bit 2 when writing may. A hangup or error counts as both.
const READ_READY = 1
const WRITE_READY = 2
// The id of the stop pipe's registration; port registrations count from 1.
const STOP_ID = 0
const MAX_EVENTS = 64

// The worker: waits, and posts [id, ready, id, ready, …] for every batch of
// fired waits. Blocking in a native call is fine here; the thread exists for
// it. Loaded from a Blob URL, so it survives bundling and `bun build --compile`.
const WORKER = `
import { dlopen, FFIType, read } from 'bun:ffi'
self.onmessage = ({ data: init }) => {
  const { i32, ptr } = FFIType
  const sys = dlopen(init.libc, init.epoll
    ? { epoll_wait: { args: [i32, ptr, i32, i32], returns: i32 } }
    : { kevent: { args: [i32, ptr, i32, ptr, i32, ptr], returns: i32 } }).symbols
  const errnoAt = dlopen(init.libc, { [init.errnoSymbol]: { args: [], returns: ptr } }).symbols[init.errnoSymbol]
  const events = new Uint8Array(init.eventSize * init.maxEvents)
  const view = new DataView(events.buffer)
  for (;;) {
    const count = init.epoll
      ? sys.epoll_wait(init.fd, events, init.maxEvents, -1)
      : sys.kevent(init.fd, null, 0, events, init.maxEvents, null)
    if (count < 0) {
      const errno = read.i32(errnoAt(), 0)
      if (errno === init.EINTR) continue
      postMessage({ failed: errno })
      return
    }
    const fired = []
    let stop = false
    for (let i = 0; i < count; i++) {
      const at = i * init.eventSize
      let id
      let ready
      if (init.epoll) {
        const flags = view.getUint32(at, true)
        id = Number(view.getBigUint64(at + init.dataOffset, true))
        ready = (flags & init.readFlags ? 1 : 0) | (flags & init.writeFlags ? 2 : 0)
      } else {
        id = Number(view.getBigUint64(at + 24, true))
        ready = view.getInt16(at + 8, true) === init.EVFILT_WRITE ? 2 : 1
      }
      if (id === 0) stop = true
      else fired.push(id, ready)
    }
    if (fired.length > 0) postMessage(fired)
    if (stop) {
      postMessage({ stopped: true })
      return
    }
  }
}
`

// struct epoll_event is packed on x86-64 only: 12 bytes, data at 4.
const EPOLL_EVENT = process.arch === 'x64' ? { size: 12, data: 4 } : { size: 16, data: 8 }
// struct kevent: ident, filter, flags, fflags, data, udata.
const KEVENT = { size: 32, filter: 8, flags: 10, udata: 24 }

let workerUrl: string | undefined

const { i32, ptr } = FFIType
const epollSymbols = {
  pipe: { args: [ptr], returns: i32 },
  epoll_create1: { args: [i32], returns: i32 },
  epoll_ctl: { args: [i32, i32, i32, ptr], returns: i32 },
} as const
const kqueueSymbols = {
  pipe: { args: [ptr], returns: i32 },
  kqueue: { args: [], returns: i32 },
  kevent: { args: [i32, ptr, i32, ptr, i32, ptr], returns: i32 },
} as const
let epoll: ReturnType<typeof dlopen<typeof epollSymbols>>['symbols'] | undefined
let kqueue: ReturnType<typeof dlopen<typeof kqueueSymbols>>['symbols'] | undefined

// One fd's registration, and whoever waits on it.
interface Watched {
  readonly fd: number
  readonly id: number
  /** epoll: in the set (ADD done); kqueue never needs it. */
  added: boolean
  read: (() => void) | null
  write: (() => void) | null
}

export class Poller {
  readonly #lib: Libc
  readonly #c: PosixConstants
  readonly #arm: (watched: Watched, direction: Direction) => number
  readonly #remove: (watched: Watched) => void
  readonly #fd: number
  readonly #stopPipe: readonly [number, number]
  readonly #worker: Worker
  readonly #byFd = new Map<number, Watched>()
  readonly #byId = new Map<number, Watched>()
  #nextId = STOP_ID + 1
  #users = 0
  #failed = false
  #stopping = false
  #shutDownDone = false

  /** The poller, or null if this system won't give us one: ports then poll on a timer. */
  static create(lib: Libc, c: PosixConstants): Poller | null {
    try {
      return new Poller(lib, c)
    } catch {
      return null
    }
  }

  private constructor(lib: Libc, c: PosixConstants) {
    this.#lib = lib
    this.#c = c
    const p = c.poller
    const pipeFds = new Int32Array(2)
    let fd = -1
    let init: Record<string, unknown>
    if (p.kind === 'epoll') {
      const sys = (epoll ??= dlopen(lib.path, epollSymbols).symbols)
      if (sys.pipe(pipeFds) < 0) throw new Error('pipe')
      fd = sys.epoll_create1(p.EPOLL_CLOEXEC)
      this.#arm = (watched) => this.#armEpoll(sys, p, watched)
      this.#remove = (watched) => {
        if (watched.added) sys.epoll_ctl(this.#fd, p.EPOLL_CTL_DEL, watched.fd, null)
      }
      init = {
        epoll: true,
        eventSize: EPOLL_EVENT.size,
        dataOffset: EPOLL_EVENT.data,
        readFlags: p.EPOLLIN | p.EPOLLERR | p.EPOLLHUP,
        writeFlags: p.EPOLLOUT | p.EPOLLERR | p.EPOLLHUP,
      }
    } else {
      const sys = (kqueue ??= dlopen(lib.path, kqueueSymbols).symbols)
      if (sys.pipe(pipeFds) < 0) throw new Error('pipe')
      fd = sys.kqueue()
      this.#arm = (watched, direction) => this.#armKqueue(sys, p, watched, direction)
      this.#remove = () => {} // closing the fd removes its kevents
      init = { epoll: false, eventSize: KEVENT.size, EVFILT_WRITE: p.EVFILT_WRITE }
    }
    this.#stopPipe = [pipeFds[0] ?? -1, pipeFds[1] ?? -1]
    this.#fd = fd
    const stop: Watched = { fd: this.#stopPipe[0], id: STOP_ID, added: false, read: null, write: null }
    // Spawned children must not inherit the worker's descriptors.
    const ready = [fd, ...this.#stopPipe].every((each) => each >= 0 && lib.ioctl(each, c.FIOCLEX, null) === 0)
    if (!ready || this.#arm(stop, 'read') !== 0) {
      for (const each of [fd, ...this.#stopPipe]) if (each >= 0) lib.close(each)
      throw new Error('poller setup')
    }

    workerUrl ??= URL.createObjectURL(new Blob([WORKER], { type: 'application/javascript' }))
    this.#worker = new Worker(workerUrl)
    // Waits hold the process open (holdOpen()); the worker itself never does.
    this.#worker.unref()
    this.#worker.onmessage = ({ data }: MessageEvent<number[] | { failed: number } | { stopped: true }>) => {
      if (Array.isArray(data)) this.#fired(data)
      else if ('stopped' in data) this.#shutDown()
      else this.#fail()
    }
    this.#worker.onerror = () => this.#fail()
    this.#worker.postMessage({
      ...init,
      fd,
      libc: lib.path,
      errnoSymbol: c.errnoSymbol,
      EINTR: c.errno.EINTR,
      maxEvents: MAX_EVENTS,
    })
  }

  /** Whether it can still take waits; a stopping or failed poller can't. */
  get usable(): boolean {
    return !this.#failed && !this.#stopping
  }

  /** A port opened: the poller runs until each port has released it. */
  acquire(): void {
    this.#users++
  }

  /** A port closed. After the last one, the worker stops. */
  release(): void {
    if (--this.#users > 0 || this.#stopping || this.#users < 0) return
    this.#stopping = true
    if (this.#failed) this.#shutDown()
    else this.#lib.write(this.#stopPipe[1], Uint8Array.of(1))
  }

  /**
   * Wait until `fd` may be readable or writable. If the system won't take the
   * wait, `done` resolves after `fallbackMs` instead, and the caller simply
   * looks again then.
   */
  wait(fd: number, direction: Direction, fallbackMs: number): ReadyWait {
    let resolve!: () => void
    const done = new Promise<void>((settle) => (resolve = settle))
    let waiting = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let watched = this.#byFd.get(fd)
    const finish = () => {
      if (!waiting) return
      waiting = false
      clearTimeout(timer)
      if (watched?.[direction] === finish) watched[direction] = null
      letGo()
      resolve()
    }
    holdOpen()

    if (!this.usable) {
      timer = setTimeout(finish, fallbackMs)
      return { done, stop: finish }
    }
    if (!watched) {
      watched = { fd, id: this.#nextId++, added: false, read: null, write: null }
      this.#byFd.set(fd, watched)
      this.#byId.set(watched.id, watched)
    }
    watched[direction]?.() // the core never waits twice in one direction; just in case
    watched[direction] = finish
    if (this.#arm(watched, direction) !== 0) {
      watched[direction] = null
      timer = setTimeout(finish, fallbackMs)
    }
    return { done, stop: finish }
  }

  /** `fd` is about to be closed: drop its registration and wake its waiters. */
  forget(fd: number): void {
    const watched = this.#byFd.get(fd)
    if (!watched) return
    this.#byFd.delete(fd)
    this.#byId.delete(watched.id)
    if (!this.#failed) this.#remove(watched)
    watched.read?.()
    watched.write?.()
  }

  // epoll keeps one registration per fd: arming sets everything the fd's
  // waiters want, and a fired one-shot disarms all of it.
  #armEpoll(sys: { epoll_ctl: (epfd: number, op: number, fd: number, event: Uint8Array | null) => number }, p: EpollConstants, watched: Watched): number {
    let flags = p.EPOLLONESHOT
    if (watched.read || watched.id === STOP_ID) flags |= p.EPOLLIN
    if (watched.write) flags |= p.EPOLLOUT
    if (watched.id === STOP_ID) flags &= ~p.EPOLLONESHOT // the stop pipe stays armed
    const event = new Uint8Array(EPOLL_EVENT.size)
    const view = new DataView(event.buffer)
    view.setUint32(0, flags >>> 0, true)
    view.setBigUint64(EPOLL_EVENT.data, BigInt(watched.id), true)
    const { ENOENT, EEXIST } = this.#c.errno
    let op = watched.added ? p.EPOLL_CTL_MOD : p.EPOLL_CTL_ADD
    for (let attempt = 0; attempt < 2; attempt++) {
      if (sys.epoll_ctl(this.#fd, op, watched.fd, event) === 0) {
        watched.added = true
        return 0
      }
      const errno = this.#lib.errno()
      if (errno === ENOENT) op = p.EPOLL_CTL_ADD
      else if (errno === EEXIST) op = p.EPOLL_CTL_MOD
      else return errno
    }
    return this.#lib.errno()
  }

  // kqueue has a filter per direction, each its own one-shot registration.
  #armKqueue(
    sys: { kevent: (kq: number, changes: Uint8Array, count: number, events: null, max: number, timeout: null) => number },
    p: KqueueConstants,
    watched: Watched,
    direction: Direction,
  ): number {
    const change = new Uint8Array(KEVENT.size)
    const view = new DataView(change.buffer)
    view.setBigUint64(0, BigInt(watched.fd), true)
    view.setInt16(KEVENT.filter, direction === 'read' ? p.EVFILT_READ : p.EVFILT_WRITE, true)
    view.setUint16(KEVENT.flags, watched.id === STOP_ID ? p.EV_ADD : p.EV_ADD | p.EV_ONESHOT, true)
    view.setBigUint64(KEVENT.udata, BigInt(watched.id), true)
    return sys.kevent(this.#fd, change, 1, null, 0, null) === 0 ? 0 : this.#lib.errno()
  }

  #fired(list: number[]): void {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const watched = this.#byId.get(list[i] ?? -1)
      if (!watched) continue // forgotten since
      const ready = list[i + 1] ?? 0
      if (ready & READ_READY) watched.read?.()
      if (ready & WRITE_READY) watched.write?.()
      // epoll disarmed the whole registration; arm it again for whoever still waits.
      const left: Direction | null = watched.read ? 'read' : watched.write ? 'write' : null
      if (left && this.#c.poller.kind === 'epoll' && this.#arm(watched, left) !== 0) {
        watched.read?.()
        watched.write?.()
      }
    }
  }

  // The worker can't wait any more: wake everyone, and let them fall back to timers.
  #fail(): void {
    if (this.#failed) return
    this.#failed = true
    for (const watched of this.#byFd.values()) {
      watched.read?.()
      watched.write?.()
    }
    this.#byFd.clear()
    this.#byId.clear()
    if (this.#stopping) this.#shutDown()
  }

  // The worker has left its loop (or died): its descriptors are ours to
  // close — once only, since a second close could hit a reused number.
  #shutDown(): void {
    if (this.#shutDownDone) return
    this.#shutDownDone = true
    this.#worker.terminate()
    for (const fd of [this.#fd, ...this.#stopPipe]) if (fd >= 0) this.#lib.close(fd)
  }
}

let current: Poller | null = null
let unavailable = false

/**
 * The process's poller, for a port that just opened; release() it on close.
 * Null where none can be had — the port then polls on a timer.
 */
export function acquirePoller(lib: Libc, c: PosixConstants): Poller | null {
  if (unavailable) return null
  if (!current?.usable) {
    current = Poller.create(lib, c)
    if (!current) {
      unavailable = true
      return null
    }
  }
  current.acquire()
  return current
}
