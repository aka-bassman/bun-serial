// Linux port enumeration from sysfs: every tty backed by a real device, with
// USB metadata from the nearest USB device above it.

import { access, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { PortInfo } from '../types.js'

export interface LinuxRoots {
  /** @default '/sys' */
  sys?: string
  /** @default '/dev' */
  dev?: string
}

export async function listLinux(roots: LinuxRoots = {}): Promise<PortInfo[]> {
  const sys = roots.sys ?? '/sys'
  const dev = roots.dev ?? '/dev'
  const classDir = join(sys, 'class', 'tty')
  const [names, pnpIds] = await Promise.all([
    readdir(classDir).catch(() => [] as string[]),
    readPnpIds(join(dev, 'serial', 'by-id')),
  ])
  const ports = await Promise.all(names.map((name) => describe(classDir, dev, name, pnpIds)))
  return ports
    .filter((port): port is PortInfo => port !== null)
    .sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))
}

/** tty name → /dev/serial/by-id entry naming it: the identity that survives replugs. */
export async function readPnpIds(byIdDir: string): Promise<Map<string, string>> {
  const entries = await readdir(byIdDir).catch(() => [] as string[])
  const pairs = await Promise.all(
    entries.map(async (entry) => {
      const target = await readlink(join(byIdDir, entry)).catch(() => '')
      return [basename(target), entry] as const
    }),
  )
  return new Map(pairs.filter(([name]) => name !== ''))
}

async function describe(
  classDir: string,
  dev: string,
  name: string,
  pnpIds: ReadonlyMap<string, string>,
): Promise<PortInfo | null> {
  const ttyDir = join(classDir, name)
  // Virtual terminals and ptys have no backing device.
  const device = await realpath(join(ttyDir, 'device')).catch(() => null)
  if (!device) return null
  // serial8250 registers ttyS0–ttyS31 whether or not a UART is fitted; the
  // missing ones report port type 0 (PORT_UNKNOWN).
  if ((await readAttribute(join(ttyDir, 'type'))) === '0') return null
  const path = join(dev, name)
  if (!(await exists(path))) return null

  const info: PortInfo = { path }
  const pnpId = pnpIds.get(name)
  if (pnpId) info.pnpId = pnpId

  const usb = await findUsbDevice(device)
  if (usb) {
    const [vendorId, productId, manufacturer, product, serialNumber] = await Promise.all(
      ['idVendor', 'idProduct', 'manufacturer', 'product', 'serial'].map((file) => readAttribute(join(usb, file))),
    )
    if (vendorId) info.vendorId = vendorId.toLowerCase()
    if (productId) info.productId = productId.toLowerCase()
    if (manufacturer) info.manufacturer = manufacturer
    if (product) info.product = product
    if (serialNumber) info.serialNumber = serialNumber
    // The USB devpath, e.g. "1-1.4": which physical port the device is plugged into.
    info.locationId = basename(usb)
  }
  return info
}

// A tty's device is a USB interface (ttyACM) or a usb-serial port beneath one
// (ttyUSB); the USB device itself, the directory with idVendor, sits a level
// or two above. Walk the resolved path — joining '..' onto the symlink would
// climb /sys/class instead.
async function findUsbDevice(device: string): Promise<string | null> {
  let dir = device
  for (let depth = 0; depth < 4; depth++) {
    if (await exists(join(dir, 'idVendor'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function readAttribute(path: string): Promise<string> {
  return (await readFile(path, 'utf8').catch(() => '')).trim()
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}
