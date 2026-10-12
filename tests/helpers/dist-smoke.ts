// Exercises the built package (dist/) end to end on a pty: run with
// `bun tests/helpers/dist-smoke.ts` after `bun run build`. Not type-checked with
// the rest (dist/ may not exist yet).
import { list, readlineParser, SerialPort } from '../../dist/index.js'
import { openPty } from './pty.js'

const pty = openPty()
const port = new SerialPort({ path: pty.slavePath, baudRate: 115200 })
const lines: string[] = []
port.pipe(readlineParser()).on('data', (line) => lines.push(line))
await new Promise<void>((resolve) => port.once('open', () => resolve()))

const echoed = pty.collect(6)
await port.write('ping\r\n')
pty.writeMaster('pong\n')
await port.drain()
while (lines.length === 0) await Bun.sleep(5)
await port.close()
pty.closeMaster()

const received = new TextDecoder().decode(await echoed)
const ports = await list()
console.log(JSON.stringify({ bun: Bun.version, platform: process.platform, sent: received, got: lines, listed: Array.isArray(ports) }))
if (received !== 'ping\r\n' || lines[0] !== 'pong') process.exit(1)
