// Run as a child process by serial-port.test.ts: without onListenerError, a
// throwing listener — or a throwing onListenerError — must surface as an
// uncaught exception while the port keeps reading and the other listeners
// still run. So must an 'error' event nobody listens to, handler or not.
import { MockBinding } from '../../src/bindings/mock/index.js'
import { SerialPort } from '../../src/serial-port.js'

const uncaught: string[] = []
process.on('uncaughtException', (err) => uncaught.push(err.message))

const binding = new MockBinding()
const device = binding.addPort('/dev/mock0')
const port = new SerialPort({ path: '/dev/mock0', baudRate: 9600, binding })
await new Promise<void>((resolve) => port.once('open', () => resolve()))

let calls = 0
let seen = 0
port.on('data', () => {
  calls++
  if (calls === 1) throw new Error('listener failed')
})
port.on('data', () => seen++)
device.emit('a')
await Bun.sleep(10)
device.emit('b')
await Bun.sleep(10)
const open = port.isOpen
await port.close()

binding.addPort('/dev/mock1')
const handled = new SerialPort({
  path: '/dev/mock1',
  baudRate: 9600,
  binding,
  onListenerError: (err) => {
    throw new Error(`handler failed: ${(err as Error).message}`)
  },
})
handled.on('open', () => {
  throw new Error('open listener failed')
})
const opened = await new Promise<boolean>((resolve) => handled.once('open', () => resolve(true)))
await handled.close()

new SerialPort({ path: '/dev/missing', baudRate: 9600, binding, onListenerError: () => {} })
await Bun.sleep(10)

console.log(JSON.stringify({ uncaught, calls, seen, open, opened }))
