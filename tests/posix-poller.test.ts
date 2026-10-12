// The POSIX poller on its own: one worker waiting in epoll_wait (Linux) or
// kevent (macOS), with waits armed from this thread. A pipe stands in for a
// port's fd. Runs on Linux and macOS.

import { dlopen, FFIType } from 'bun:ffi'
import { describe, expect, test } from 'bun:test'
import { loadLibc } from '../src/bindings/posix/ffi.js'
import { acquirePoller, type Poller } from '../src/bindings/posix/poller.js'
import { constants, isPosix, openPty } from './helpers/pty.js'

function pipe() {
  const libc = loadLibc(constants)
  const { pipe } = dlopen(libc.path, { pipe: { args: [FFIType.ptr], returns: FFIType.i32 } }).symbols
  const fds = new Int32Array(2)
  if (pipe(fds) < 0) throw new Error('pipe failed')
  const [reader, writer] = [fds[0]!, fds[1]!]
  return {
    reader,
    writer,
    send: (text: string) => libc.write(writer, new TextEncoder().encode(text)),
    take: () => libc.read(reader, new Uint8Array(64)),
    close() {
      libc.close(reader)
      libc.close(writer)
    },
  }
}

function settled(promise: Promise<unknown>): () => boolean {
  let done = false
  void promise.then(() => (done = true))
  return () => done
}

function poller(): Poller {
  const acquired = acquirePoller(loadLibc(constants), constants)
  if (!acquired) throw new Error('no poller on this system')
  return acquired
}

describe.if(isPosix)('poller', () => {
  test('a read wait fires once the fd has data, and not before', async () => {
    const p = poller()
    const fds = pipe()
    try {
      const wait = p.wait(fds.reader, 'read', 1000)
      const fired = settled(wait.done)
      await Bun.sleep(50)
      expect(fired()).toBe(false)
      const sent = performance.now()
      fds.send('x')
      await wait.done
      expect(performance.now() - sent).toBeLessThan(50)
      expect(fds.take()).toBe(1)
      p.forget(fds.reader)
    } finally {
      fds.close()
      p.release()
    }
  })

  test('a write wait on an fd with room fires at once', async () => {
    const p = poller()
    const fds = pipe()
    try {
      await p.wait(fds.writer, 'write', 1000).done
      p.forget(fds.writer)
    } finally {
      fds.close()
      p.release()
    }
  })

  test('a fired one-shot is armed again by the next wait', async () => {
    const p = poller()
    const fds = pipe()
    try {
      for (let i = 0; i < 100; i++) {
        const wait = p.wait(fds.reader, 'read', 1000)
        fds.send('x')
        await wait.done
        expect(fds.take()).toBe(1)
      }
      p.forget(fds.reader)
    } finally {
      fds.close()
      p.release()
    }
  })

  test('read and write waits on one tty fire independently', async () => {
    const p = poller()
    const pty = openPty()
    const libc = loadLibc(constants)
    const fd = libc.open(pty.slavePath, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK)
    try {
      const reading = p.wait(fd, 'read', 60_000)
      const read = settled(reading.done)
      // An empty output queue takes writes at once; that must not wake the reader.
      await p.wait(fd, 'write', 60_000).done
      await Bun.sleep(20)
      expect(read()).toBe(false)
      pty.writeMaster('x\n')
      await reading.done
      p.forget(fd)
    } finally {
      libc.close(fd)
      pty.closeMaster()
      p.release()
    }
  })

  test('stop() and forget() end waits that would never fire', async () => {
    const p = poller()
    const fds = pipe()
    try {
      const stopped = p.wait(fds.reader, 'read', 60_000)
      stopped.stop()
      await stopped.done
      const forgotten = p.wait(fds.reader, 'read', 60_000)
      p.forget(fds.reader)
      await forgotten.done
    } finally {
      fds.close()
      p.release()
    }
  })

  test('the last release stops the worker, and the next acquire starts another', async () => {
    const first = poller()
    first.release()
    expect(first.usable).toBe(false)
    const second = poller()
    expect(second).not.toBe(first)
    const fds = pipe()
    try {
      const wait = second.wait(fds.reader, 'read', 1000)
      fds.send('x')
      await wait.done
      second.forget(fds.reader)
    } finally {
      fds.close()
      second.release()
    }
  })
})
