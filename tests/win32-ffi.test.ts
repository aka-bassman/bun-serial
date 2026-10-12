// The Windows binding's FFI half, on a real Windows machine. No serial
// hardware needed: these check that the DLLs and
// signatures load and that failures come back as clean SerialPortErrors.

import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { kernel32, setupapi, win32Message } from '../src/bindings/win32/ffi.js'
import { callOnThread, watchHandle } from '../src/bindings/win32/waits.js'
import { isSerialPortError } from '../src/errors.js'
import { list } from '../src/list.js'
import { SerialPort } from '../src/serial-port.js'
import { rejectionCode } from './helpers/errors.js'

// Events to watch, made and signaled by hand.
function events() {
  return dlopen('kernel32.dll', {
    CreateEventW: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    SetEvent: { args: [FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols
}

describe.if(process.platform === 'win32')('win32 binding on this machine', () => {
  test('kernel32 and setupapi load with every declared symbol', () => {
    expect(typeof kernel32().CreateFileW).toBe('function')
    expect(typeof setupapi().SetupDiGetClassDevsW).toBe('function')
  })

  test('list() enumerates the Ports class', async () => {
    const ports = await list()
    expect(Array.isArray(ports)).toBe(true)
    for (const port of ports) expect(port.path).toMatch(/^COM\d+$/)
  })

  test('opening a port that does not exist is NOT_FOUND', async () => {
    const port = new SerialPort({ path: 'COM250', baudRate: 9600, autoOpen: false })
    expect(await rejectionCode(port.open())).toBe('NOT_FOUND')
  })

  test('opening a device that is not a serial port fails cleanly', async () => {
    const port = new SerialPort({ path: 'NUL', baudRate: 9600, autoOpen: false })
    const error = await port.open().catch((err: unknown) => err)
    expect(isSerialPortError(error)).toBe(true)
    expect(port.isOpen).toBe(false)
  })

  test('error messages come from the system', () => {
    expect(win32Message(5)).not.toStartWith('Win32 error')
  })

  test('a watched event is reported once signaled, and a stopped watch lets go', async () => {
    const k = events()
    const event = k.CreateEventW(null, 1, 0, null) as Pointer
    const watch = watchHandle(event)
    let fired = false
    void watch.done.then(() => (fired = true))
    await Bun.sleep(30)
    expect(fired).toBe(false)
    const signaled = performance.now()
    k.SetEvent(event)
    await watch.done
    expect(performance.now() - signaled).toBeLessThan(50)

    const idle = k.CreateEventW(null, 1, 0, null) as Pointer
    const stopped = watchHandle(idle)
    stopped.stop()
    await stopped.done
    k.CloseHandle(idle)
    k.CloseHandle(event)
  })

  test('FlushFileBuffers and CloseHandle run on threads of their own', async () => {
    const k = events()
    const event = k.CreateEventW(null, 1, 0, null) as Pointer
    expect(await callOnThread('FlushFileBuffers', event).result).toBe(false) // not a file
    expect(await callOnThread('CloseHandle', event).result).toBe(true)
  })

  test('a watch keeps the process alive until it fires, and no longer', async () => {
    const waits = join(import.meta.dir, '../src/bindings/win32/waits.ts')
    const script = `
      import { dlopen, FFIType } from 'bun:ffi'
      import { watchHandle } from ${JSON.stringify(waits)}
      const k = dlopen('kernel32.dll', {
        CreateEventW: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
        SetEvent: { args: [FFIType.ptr], returns: FFIType.i32 },
      }).symbols
      const event = k.CreateEventW(null, 1, 0, null)
      watchHandle(event).done.then(() => console.log('fired'))
      // Doesn't hold the process open by itself: only the watch can.
      setTimeout(() => k.SetEvent(event), 300).unref()
    `
    const started = performance.now()
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(code).toBe(0)
    expect(output.trim()).toBe('fired')
    expect(performance.now() - started).toBeGreaterThanOrEqual(280)
  })
})
