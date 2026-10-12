// Compiled against the built declarations (dist/) through the package's own
// exports, under strict consumer settings. `bun run typecheck:consumer`.

import {
  isSerialPortError,
  list,
  readlineParser,
  SerialPort,
  SerialPortError,
  type ModemStatus,
  type PortInfo,
  type SerialErrorCode,
} from 'bun-serial'
import { MockBinding } from 'bun-serial/mock'
import { byteLengthParser, delimiterParser } from 'bun-serial/parsers'

async function main(): Promise<void> {
  const ports: PortInfo[] = await list()
  const first: string | undefined = ports[0]?.path

  const port = new SerialPort({ path: first ?? '/dev/ttyUSB0', baudRate: 115200, autoOpen: false })
  port.on('data', (chunk: Uint8Array) => chunk.byteLength)
  port.on('error', (error: SerialPortError) => {
    const code: SerialErrorCode = error.code
    return code === 'DISCONNECTED'
  })
  port.on('close', (cause?: SerialPortError) => cause?.message)
  port.once('open', () => undefined)

  await port.open()
  await port.write('hello\n')
  await port.write(Uint8Array.of(1, 2, 3))
  await port.write([0x0d, 0x0a])
  await port.drain()
  await port.update({ baudRate: 9600 })
  await port.set({ dtr: false, rts: true, brk: false })
  const status: ModemStatus = await port.get()
  status.cts satisfies boolean

  const lines = port.pipe(readlineParser({ delimiter: '\r\n' }))
  lines.on('data', (line: string) => line.toUpperCase())
  port.unpipe(lines)

  const frames = port.pipe(byteLengthParser({ length: 8 }))
  frames.on('data', (frame: Uint8Array) => frame[0])
  port.pipe(delimiterParser({ delimiter: [0x7e], includeDelimiter: true }))

  const failure = await port.close().catch((err: unknown) => err)
  if (isSerialPortError(failure, 'NOT_OPEN')) failure.osCode satisfies number | undefined

  const binding = new MockBinding()
  const device = binding.addPort('/dev/mock0', { vendorId: '0403' })
  await using mock = new SerialPort({ path: '/dev/mock0', baudRate: 9600, binding })
  device.emit('ok')
  await mock.write(device.takeWritten())
}

void main
// @ts-expect-error baudRate is required
void new SerialPort({ path: '/dev/ttyUSB0' })
// @ts-expect-error parity values are a closed set
void new SerialPort({ path: '/dev/ttyUSB0', baudRate: 9600, parity: 'sometimes' })
