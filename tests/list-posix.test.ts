import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { listDarwin } from '../src/bindings/posix/list-darwin.js'
import { listLinux, readPnpIds } from '../src/bindings/posix/list-linux.js'

// A miniature sysfs: one USB-serial adapter, one CDC-ACM board, a real
// on-board UART, a phantom 8250 slot and a virtual console.
async function fakeSysfs(root: string) {
  const sys = join(root, 'sys')
  const dev = join(root, 'dev')
  const usb = join(sys, 'devices/pci0000:00/0000:00:14.0/usb1')
  const files: Record<string, string> = {
    // FTDI adapter on port 1-1.4: device → interface → usb-serial port → tty
    '1-1.4/idVendor': '0403\n',
    '1-1.4/idProduct': '6001\n',
    '1-1.4/manufacturer': 'FTDI\n',
    '1-1.4/product': 'FT232R USB UART\n',
    '1-1.4/serial': 'A50285BI\n',
    // Arduino on port 1-2: device → interface (ttyACM hangs off the interface)
    '1-2/idVendor': '2341\n',
    '1-2/idProduct': '0043\n',
    '1-2/manufacturer': 'Arduino (www.arduino.cc)\n',
    '1-2/product': 'Uno\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(usb, path)), { recursive: true })
    await writeFile(join(usb, path), content)
  }
  const devices = {
    ttyUSB0: join(usb, '1-1.4/1-1.4:1.0/ttyUSB0'),
    ttyACM0: join(usb, '1-2/1-2:1.0'),
    ttyAMA0: join(sys, 'devices/platform/fe201000.serial'),
    ttyS1: join(sys, 'devices/platform/serial8250'),
  }
  const classDir = join(sys, 'class/tty')
  await mkdir(classDir, { recursive: true })
  for (const [name, device] of Object.entries(devices)) {
    await mkdir(device, { recursive: true })
    const ttyDir = join(sys, 'devices/virtual-tty', name)
    await mkdir(ttyDir, { recursive: true })
    await symlink(device, join(ttyDir, 'device'))
    await symlink(ttyDir, join(classDir, name))
  }
  await writeFile(join(sys, 'devices/virtual-tty/ttyAMA0/type'), '83\n')
  await writeFile(join(sys, 'devices/virtual-tty/ttyS1/type'), '0\n')
  await mkdir(join(classDir, 'tty0'), { recursive: true }) // no device link

  await mkdir(join(dev, 'serial/by-id'), { recursive: true })
  for (const name of ['ttyUSB0', 'ttyACM0', 'ttyAMA0', 'ttyS1', 'tty0']) await writeFile(join(dev, name), '')
  await symlink('../../ttyUSB0', join(dev, 'serial/by-id/usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0'))
  return { sys, dev }
}

// Symlinks need extra privileges on Windows; the fake sysfs is a POSIX affair.
describe.if(process.platform !== 'win32')('listLinux', () => {
  let root: string
  let roots: { sys: string; dev: string }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bun-serial-sysfs-'))
    roots = await fakeSysfs(root)
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test('lists real ports with USB metadata, skipping phantoms and virtual ttys', async () => {
    expect(await listLinux(roots)).toEqual([
      {
        path: join(roots.dev, 'ttyACM0'),
        vendorId: '2341',
        productId: '0043',
        manufacturer: 'Arduino (www.arduino.cc)',
        product: 'Uno',
        locationId: '1-2',
      },
      { path: join(roots.dev, 'ttyAMA0') },
      {
        path: join(roots.dev, 'ttyUSB0'),
        pnpId: 'usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0',
        vendorId: '0403',
        productId: '6001',
        manufacturer: 'FTDI',
        product: 'FT232R USB UART',
        serialNumber: 'A50285BI',
        locationId: '1-1.4',
      },
    ])
  })

  test('readPnpIds maps tty names to their by-id names', async () => {
    const ids = await readPnpIds(join(roots.dev, 'serial/by-id'))
    expect(ids.get('ttyUSB0')).toBe('usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0')
  })

  test('missing directories mean no ports, not an error', async () => {
    expect(await listLinux({ sys: '/nonexistent', dev: '/nonexistent' })).toEqual([])
    expect((await readPnpIds('/nonexistent/by-id')).size).toBe(0)
  })
})

describe.if(process.platform === 'darwin')('listDarwin', () => {
  test('finds every callout device IOKit knows about', async () => {
    const ports = await listDarwin()
    const callouts = (await readdir('/dev')).filter((name) => name.startsWith('cu.')).map((name) => `/dev/${name}`)
    expect(ports.map((port) => port.path).sort()).toEqual(callouts.sort())
    for (const port of ports) {
      if (port.vendorId !== undefined) expect(port.vendorId).toMatch(/^[0-9a-f]{4}$/)
    }
  })
})
