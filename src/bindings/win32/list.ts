// Windows port enumeration through SetupAPI: the Ports device class (what
// Device Manager shows under "Ports (COM & LPT)"), with each port's name from
// its registry key and USB metadata from its device instance ID. Based on the
// enumeration in malteheringOrgatex/bun-serialport@windows-support (MIT).

import type { PortInfo } from '../types.js'
import {
  CM_DRP_LOCATION_INFORMATION,
  CR_SUCCESS,
  DICS_FLAG_GLOBAL,
  DIGCF_PRESENT,
  DIREG_DEV,
  ERROR_SUCCESS,
  GUID_DEVCLASS_PORTS,
  KEY_READ,
  SP_DEVINFO_DATA,
  SPDRP_DEVICEDESC,
  SPDRP_LOCATION_INFORMATION,
  SPDRP_MFG,
} from './constants.js'
import { advapi32, cfgmgr32, setupapi, validHandle, type Handle } from './ffi.js'
import { fromWide, parseInstanceId, wide } from './structs.js'

const PORT_NAME = wide('PortName')
const STRING_BUFFER_BYTES = 1024

export async function listWindows(): Promise<PortInfo[]> {
  const setup = setupapi()
  const devices = setup.SetupDiGetClassDevsW(GUID_DEVCLASS_PORTS, null, null, DIGCF_PRESENT)
  if (!validHandle(devices)) return []

  const ports: PortInfo[] = []
  try {
    for (let index = 0; ; index++) {
      const device = new Uint8Array(SP_DEVINFO_DATA.size)
      new DataView(device.buffer).setUint32(0, SP_DEVINFO_DATA.size, true) // cbSize
      if (!setup.SetupDiEnumDeviceInfo(devices, index, device)) break // ERROR_NO_MORE_ITEMS
      const port = describe(devices, device)
      if (port) ports.push(port)
    }
  } finally {
    setup.SetupDiDestroyDeviceInfoList(devices)
  }
  return ports.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
}

function describe(devices: Handle, device: Uint8Array): PortInfo | null {
  // LPT ports share the class; only COM ports are serial ports.
  const path = portName(devices, device)
  if (!path || !/^COM\d+$/i.test(path)) return null
  const info: PortInfo = { path }

  const instanceId = instanceIdOf(devices, device)
  const ids = instanceId ? parseInstanceId(instanceId) : {}
  if (instanceId) {
    info.pnpId = instanceId
    if (ids.vendorId) info.vendorId = ids.vendorId
    if (ids.productId) info.productId = ids.productId
  }
  // Some ports sit one node below their USB device: an interface of a
  // composite device, whose last segment is made up, or a port on FTDI's own
  // bus, which has no location. The USB device above has both.
  const usbParent = ids.vendorId ? usbParentOf(device, ids.vendorId) : undefined
  const serialNumber = ids.serialNumber ?? (usbParent && parseInstanceId(usbParent.id).serialNumber)
  if (serialNumber) info.serialNumber = serialNumber
  const product = registryProperty(devices, device, SPDRP_DEVICEDESC)
  if (product) info.product = product
  const manufacturer = registryProperty(devices, device, SPDRP_MFG)
  if (manufacturer) info.manufacturer = manufacturer
  const locationId = registryProperty(devices, device, SPDRP_LOCATION_INFORMATION) ?? (usbParent && parentLocation(usbParent.devInst))
  if (locationId) info.locationId = locationId
  return info
}

// "PortName" under the device's own "Device Parameters" key: the authoritative
// link between a device node and the COMn name it opens as.
function portName(devices: Handle, device: Uint8Array): string | undefined {
  const key = setupapi().SetupDiOpenDevRegKey(devices, device, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ)
  if (!validHandle(key)) return undefined
  try {
    const data = new Uint8Array(256)
    const size = Uint32Array.of(data.length)
    if (advapi32().RegQueryValueExW(key, PORT_NAME, null, null, data, size) !== ERROR_SUCCESS) return undefined
    return fromWide(data, size[0]) || undefined
  } finally {
    advapi32().RegCloseKey(key)
  }
}

function instanceIdOf(devices: Handle, device: Uint8Array): string | undefined {
  const buffer = new Uint8Array(STRING_BUFFER_BYTES)
  if (!setupapi().SetupDiGetDeviceInstanceIdW(devices, device, buffer, buffer.length / 2, null)) return undefined
  return fromWide(buffer) || undefined
}

function registryProperty(devices: Handle, device: Uint8Array, property: number): string | undefined {
  const buffer = new Uint8Array(STRING_BUFFER_BYTES)
  if (!setupapi().SetupDiGetDeviceRegistryPropertyW(devices, device, property, null, buffer, buffer.length, null)) {
    return undefined
  }
  return fromWide(buffer) || undefined
}

// The device node above the port's, if it is the same USB device.
function usbParentOf(device: Uint8Array, vendorId: string): { devInst: number; id: string } | undefined {
  const cm = cfgmgr32()
  const devInst = new DataView(device.buffer).getUint32(SP_DEVINFO_DATA.DevInst, true)
  const parent = new Uint32Array(1)
  if (cm.CM_Get_Parent(parent, devInst, 0) !== CR_SUCCESS) return undefined
  const buffer = new Uint8Array(STRING_BUFFER_BYTES)
  if (cm.CM_Get_Device_IDW(parent[0] ?? 0, buffer, buffer.length / 2, 0) !== CR_SUCCESS) return undefined
  const id = fromWide(buffer)
  return parseInstanceId(id).vendorId === vendorId ? { devInst: parent[0] ?? 0, id } : undefined
}

function parentLocation(devInst: number): string | undefined {
  const buffer = new Uint8Array(STRING_BUFFER_BYTES)
  const length = Uint32Array.of(buffer.length)
  const result = cfgmgr32().CM_Get_DevNode_Registry_PropertyW(devInst, CM_DRP_LOCATION_INFORMATION, null, buffer, length, 0)
  return result === CR_SUCCESS ? fromWide(buffer, length[0]) || undefined : undefined
}
