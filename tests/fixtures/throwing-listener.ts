// Run as a child process by serial-port.test.ts: a throwing 'data' listener
// must surface as an uncaught exception while the port keeps reading.
import { MockBinding } from '../../src/bindings/mock/index.js'
import { SerialPort } from '../../src/serial-port.js'

const uncaught: string[] = []
process.on('uncaughtException', (err) => uncaught.push(err.message))

const binding = new MockBinding()
const device = binding.addPort('/dev/mock0')
const port = new SerialPort({ path: '/dev/mock0', baudRate: 9600, binding })
await new Promise<void>((resolve) => port.once('open', () => resolve()))

let calls = 0
port.on('data', () => {
  calls++
  if (calls === 1) throw new Error('listener failed')
})
device.emit('a')
await Bun.sleep(10)
device.emit('b')
await Bun.sleep(10)
console.log(JSON.stringify({ uncaught, calls, open: port.isOpen }))
await port.close()
