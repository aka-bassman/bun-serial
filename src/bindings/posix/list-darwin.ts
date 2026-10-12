// macOS port enumeration through IOKit: every IOSerialBSDClient, with USB
// metadata found by searching up the registry from each one.

import { dlopen, FFIType } from 'bun:ffi'
import type { PortInfo } from '../types.js'

const KERN_SUCCESS = 0
const kCFStringEncodingUTF8 = 0x08000100
const kCFNumberSInt64Type = 4
const kIORegistryIterateRecursively = 1
const kIORegistryIterateParents = 2

const iokitSymbols = {
  IOServiceMatching: { args: [FFIType.ptr], returns: FFIType.ptr },
  IOServiceGetMatchingServices: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  IOIteratorNext: { args: [FFIType.u32], returns: FFIType.u32 },
  IOObjectRelease: { args: [FFIType.u32], returns: FFIType.i32 },
  IORegistryEntryCreateCFProperty: {
    args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.ptr,
  },
  IORegistryEntrySearchCFProperty: {
    args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.ptr,
  },
} as const

const coreFoundationSymbols = {
  CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
  CFStringGetCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.u8 },
  CFGetTypeID: { args: [FFIType.ptr], returns: FFIType.u64 },
  CFStringGetTypeID: { args: [], returns: FFIType.u64 },
  CFNumberGetTypeID: { args: [], returns: FFIType.u64 },
  CFNumberGetValue: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.u8 },
  CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
} as const

type Pointer = NonNullable<ReturnType<ReturnType<typeof loadFrameworks>['iokit']['IOServiceMatching']>>

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const servicePlane = cString('IOService')

let frameworks: ReturnType<typeof loadFrameworks> | undefined
const keys = new Map<string, Pointer>()

function loadFrameworks() {
  const iokit = dlopen('/System/Library/Frameworks/IOKit.framework/IOKit', iokitSymbols).symbols
  const cf = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', coreFoundationSymbols).symbols
  return { iokit, cf, stringType: cf.CFStringGetTypeID(), numberType: cf.CFNumberGetTypeID() }
}

export async function listDarwin(): Promise<PortInfo[]> {
  frameworks ??= loadFrameworks()
  const { iokit } = frameworks

  // IOServiceGetMatchingServices consumes the matching dictionary.
  const matching = iokit.IOServiceMatching(cString('IOSerialBSDClient'))
  const iteratorOut = new Uint32Array(1)
  if (!matching || iokit.IOServiceGetMatchingServices(0, matching, iteratorOut) !== KERN_SUCCESS) return []
  const iterator = iteratorOut[0] ?? 0

  const ports: PortInfo[] = []
  try {
    for (let service = iokit.IOIteratorNext(iterator); service !== 0; service = iokit.IOIteratorNext(iterator)) {
      try {
        const port = describe(service)
        if (port) ports.push(port)
      } finally {
        iokit.IOObjectRelease(service)
      }
    }
  } finally {
    iokit.IOObjectRelease(iterator)
  }
  return ports.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
}

function describe(service: number): PortInfo | null {
  // The callout device (/dev/cu.*) doesn't wait for carrier detect, unlike /dev/tty.*.
  const path = stringProperty(service, 'IOCalloutDevice', false)
  if (!path) return null
  const info: PortInfo = { path }

  const vendorId = numberProperty(service, 'idVendor')
  const productId = numberProperty(service, 'idProduct')
  if (vendorId !== undefined) info.vendorId = hex(vendorId, 4)
  if (productId !== undefined) info.productId = hex(productId, 4)
  const manufacturer = stringProperty(service, 'USB Vendor Name', true)
  const product = stringProperty(service, 'USB Product Name', true)
  const serialNumber = stringProperty(service, 'USB Serial Number', true)
  if (manufacturer) info.manufacturer = manufacturer
  if (product) info.product = product
  if (serialNumber) info.serialNumber = serialNumber
  const locationId = numberProperty(service, 'locationID')
  if (locationId !== undefined) info.locationId = hex(locationId, 8)
  return info
}

// The service's own property, or with `searchParents` the first match on the
// way up the IOService plane — where the USB device's properties live.
function property(service: number, key: string, searchParents: boolean): Pointer | null {
  const { iokit } = frameworks!
  return searchParents
    ? iokit.IORegistryEntrySearchCFProperty(
        service,
        servicePlane,
        cfKey(key),
        null,
        kIORegistryIterateRecursively | kIORegistryIterateParents,
      )
    : iokit.IORegistryEntryCreateCFProperty(service, cfKey(key), null, 0)
}

function stringProperty(service: number, key: string, searchParents: boolean): string | undefined {
  const { cf, stringType } = frameworks!
  const ref = property(service, key, searchParents)
  if (!ref) return undefined
  try {
    if (cf.CFGetTypeID(ref) !== stringType) return undefined
    const buffer = new Uint8Array(1024)
    if (!cf.CFStringGetCString(ref, buffer, buffer.length, kCFStringEncodingUTF8)) return undefined
    const end = buffer.indexOf(0)
    return textDecoder.decode(buffer.subarray(0, end === -1 ? buffer.length : end)) || undefined
  } finally {
    cf.CFRelease(ref)
  }
}

function numberProperty(service: number, key: string): number | undefined {
  const { cf, numberType } = frameworks!
  const ref = property(service, key, true)
  if (!ref) return undefined
  try {
    if (cf.CFGetTypeID(ref) !== numberType) return undefined
    const value = new BigInt64Array(1)
    if (!cf.CFNumberGetValue(ref, kCFNumberSInt64Type, value)) return undefined
    return Number(value[0])
  } finally {
    cf.CFRelease(ref)
  }
}

// CFString keys live for the life of the process; there are only a handful.
function cfKey(key: string): Pointer {
  let ref = keys.get(key)
  if (!ref) {
    ref = frameworks!.cf.CFStringCreateWithCString(null, cString(key), kCFStringEncodingUTF8) ?? undefined
    if (!ref) throw new Error(`CFStringCreateWithCString failed for ${key}`)
    keys.set(key, ref)
  }
  return ref
}

function cString(value: string): Uint8Array {
  return textEncoder.encode(`${value}\0`)
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0')
}
