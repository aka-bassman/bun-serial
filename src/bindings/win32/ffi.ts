// kernel32, setupapi, advapi32 and cfgmgr32 through bun:ffi, each loaded on
// first use. Nothing here runs on import, so the module is safe to load on
// any OS.

import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { SerialPortError, type SerialErrorCode } from '../../errors.js'
import {
  ERROR_ACCESS_DENIED,
  ERROR_BAD_COMMAND,
  ERROR_DEV_NOT_EXIST,
  ERROR_DEVICE_NOT_CONNECTED,
  ERROR_DEVICE_REMOVED,
  ERROR_FILE_NOT_FOUND,
  ERROR_GEN_FAILURE,
  ERROR_INVALID_HANDLE,
  ERROR_INVALID_NAME,
  ERROR_NO_SUCH_DEVICE,
  ERROR_NOT_READY,
  ERROR_OPERATION_ABORTED,
  ERROR_PATH_NOT_FOUND,
  ERROR_SHARING_VIOLATION,
  FORMAT_MESSAGE_FLAGS,
} from './constants.js'

const ptr = FFIType.ptr
const u32 = FFIType.u32
const i32 = FFIType.i32
const u64 = FFIType.u64

const kernel32Symbols = {
  CreateFileW: { args: [ptr, u32, u32, ptr, u32, u32, ptr], returns: ptr },
  CloseHandle: { args: [ptr], returns: i32 },
  GetLastError: { args: [], returns: u32 },
  FormatMessageW: { args: [u32, ptr, u32, u32, ptr, u32, ptr], returns: u32 },
  GetCommState: { args: [ptr, ptr], returns: i32 },
  SetCommState: { args: [ptr, ptr], returns: i32 },
  SetCommTimeouts: { args: [ptr, ptr], returns: i32 },
  SetupComm: { args: [ptr, u32, u32], returns: i32 },
  ReadFile: { args: [ptr, ptr, u32, ptr, ptr], returns: i32 },
  WriteFile: { args: [ptr, ptr, u32, ptr, ptr], returns: i32 },
  GetOverlappedResult: { args: [ptr, ptr, ptr, i32], returns: i32 },
  CancelIoEx: { args: [ptr, ptr], returns: i32 },
  CreateEventW: { args: [ptr, i32, i32, ptr], returns: ptr },
  EscapeCommFunction: { args: [ptr, u32], returns: i32 },
  GetCommModemStatus: { args: [ptr, ptr], returns: i32 },
  PurgeComm: { args: [ptr, u32], returns: i32 },
  ClearCommError: { args: [ptr, ptr, ptr], returns: i32 },
  // waits.ts: thread-pool waits, and calls run on threads of their own.
  RegisterWaitForSingleObject: { args: [ptr, ptr, ptr, ptr, u32, u32], returns: i32 },
  UnregisterWaitEx: { args: [ptr, u64], returns: i32 },
  WaitForSingleObject: { args: [ptr, u32], returns: u32 },
  CreateThread: { args: [ptr, u64, ptr, ptr, u32, ptr], returns: ptr },
  GetExitCodeThread: { args: [ptr, ptr], returns: i32 },
  GetModuleHandleW: { args: [ptr], returns: ptr },
  GetProcAddress: { args: [ptr, ptr], returns: ptr },
} as const

const setupapiSymbols = {
  SetupDiGetClassDevsW: { args: [ptr, ptr, ptr, u32], returns: ptr },
  SetupDiEnumDeviceInfo: { args: [ptr, u32, ptr], returns: i32 },
  SetupDiGetDeviceRegistryPropertyW: { args: [ptr, ptr, u32, ptr, ptr, u32, ptr], returns: i32 },
  SetupDiGetDeviceInstanceIdW: { args: [ptr, ptr, ptr, u32, ptr], returns: i32 },
  SetupDiOpenDevRegKey: { args: [ptr, ptr, u32, u32, u32, u32], returns: ptr },
  SetupDiDestroyDeviceInfoList: { args: [ptr], returns: i32 },
} as const

const advapi32Symbols = {
  RegQueryValueExW: { args: [ptr, ptr, ptr, ptr, ptr, ptr], returns: i32 },
  RegCloseKey: { args: [ptr], returns: i32 },
} as const

const cfgmgr32Symbols = {
  CM_Get_Parent: { args: [ptr, u32, u32], returns: u32 },
  CM_Get_Device_IDW: { args: [u32, ptr, u32, u32], returns: u32 },
  CM_Get_DevNode_Registry_PropertyW: { args: [u32, u32, ptr, ptr, ptr, u32], returns: u32 },
} as const

function lazy<T>(load: () => T): () => T {
  let value: T | undefined
  return () => (value ??= load())
}

/**
 * The kernel32 calls the port uses, as plain functions. The real library
 * satisfies it; tests substitute a simulated driver.
 */
export interface Kernel32Api {
  CreateFileW(name: Uint8Array, access: number, share: number, security: null, disposition: number, flags: number, template: null): Pointer | bigint | null
  CloseHandle(handle: Pointer): number
  GetLastError(): number
  GetCommState(handle: Pointer, dcb: Uint8Array): number
  SetCommState(handle: Pointer, dcb: Uint8Array): number
  SetCommTimeouts(handle: Pointer, timeouts: Uint8Array): number
  SetupComm(handle: Pointer, inQueue: number, outQueue: number): number
  ReadFile(handle: Pointer, buffer: Uint8Array, length: number, transferred: null, overlapped: Uint8Array): number
  WriteFile(handle: Pointer, buffer: Uint8Array, length: number, transferred: null, overlapped: Uint8Array): number
  GetOverlappedResult(handle: Pointer, overlapped: Uint8Array, transferred: Uint32Array, wait: number): number
  CancelIoEx(handle: Pointer, overlapped: Uint8Array | null): number
  CreateEventW(security: null, manualReset: number, initialState: number, name: null): Pointer | bigint | null
  EscapeCommFunction(handle: Pointer, fn: number): number
  GetCommModemStatus(handle: Pointer, status: Uint32Array): number
  PurgeComm(handle: Pointer, flags: number): number
  ClearCommError(handle: Pointer, errors: Uint32Array, status: Uint8Array): number
}

export const kernel32 = lazy(() => dlopen('kernel32.dll', kernel32Symbols).symbols)
export const setupapi = lazy(() => dlopen('setupapi.dll', setupapiSymbols).symbols)
export const advapi32 = lazy(() => dlopen('advapi32.dll', advapi32Symbols).symbols)
export const cfgmgr32 = lazy(() => dlopen('cfgmgr32.dll', cfgmgr32Symbols).symbols)

export type Kernel32 = Kernel32Api
export type Handle = Pointer

/**
 * A HANDLE-returning call failed when it gives NULL or INVALID_HANDLE_VALUE.
 * The latter is -1 as a 64-bit pointer, which arrives as a bigint or as a
 * number beyond float64's exact range; real handles and pointers are neither.
 */
export function validHandle(value: Pointer | bigint | null): value is Pointer {
  return typeof value === 'number' && value !== 0 && Number.isSafeInteger(value)
}

/** The system's message for a Win32 error code, e.g. "Access is denied." */
export function win32Message(code: number): string {
  try {
    const buffer = new Uint8Array(512)
    const length = kernel32().FormatMessageW(FORMAT_MESSAGE_FLAGS, null, code >>> 0, 0, buffer, buffer.length / 2, null)
    if (length > 0) {
      return new TextDecoder('utf-16le').decode(buffer.subarray(0, length * 2)).replace(/[\s.]+$/, '')
    }
  } catch {
    // Fall through to the bare code.
  }
  return `Win32 error ${code}`
}

export interface Win32ErrorOptions {
  path?: string
  code?: SerialErrorCode
}

/** A SerialPortError for a failed Win32 call, with the error mapped to a portable code. */
export function win32Error(syscall: string, error: number, options: Win32ErrorOptions = {}): SerialPortError {
  const where = options.path === undefined ? syscall : `${syscall} ${options.path}`
  return new SerialPortError(options.code ?? ioErrorCode(error), `${where}: ${win32Message(error)}`, {
    syscall,
    osCode: error,
  })
}

/** CreateFileW failures. A COM port is exclusive, so "access denied" means it's taken. */
export function openErrorCode(error: number): SerialErrorCode {
  switch (error) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_NAME:
      return 'NOT_FOUND'
    case ERROR_ACCESS_DENIED:
    case ERROR_SHARING_VIOLATION:
      return 'BUSY'
    default:
      return 'IO'
  }
}

/** Failures on an open port. Drivers report a vanished device in many ways. */
export function ioErrorCode(error: number): SerialErrorCode {
  switch (error) {
    case ERROR_ACCESS_DENIED:
    case ERROR_INVALID_HANDLE:
    case ERROR_NOT_READY:
    case ERROR_BAD_COMMAND:
    case ERROR_GEN_FAILURE:
    case ERROR_DEV_NOT_EXIST:
    case ERROR_NO_SUCH_DEVICE:
    case ERROR_OPERATION_ABORTED:
    case ERROR_DEVICE_NOT_CONNECTED:
    case ERROR_DEVICE_REMOVED:
      return 'DISCONNECTED'
    default:
      return 'IO'
  }
}
