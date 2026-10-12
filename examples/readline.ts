// Print every line a device sends, and send what you type.
//
//   bun examples/readline.ts /dev/ttyUSB0 115200

import { readlineParser, SerialPort } from '../src/index.js'

const [path, baud = '115200'] = process.argv.slice(2)
if (!path) {
  console.log('usage: bun examples/readline.ts <port> [baudRate]')
  process.exit(1)
}

const port = new SerialPort({ path, baudRate: Number(baud) })
port.on('open', () => console.log(`opened ${path}`))
port.on('error', (err) => console.error(`${err.code}: ${err.message}`))
port.on('close', (cause) => {
  console.log(cause ? `closed: ${cause.message}` : 'closed')
  process.exit(0)
})
port.pipe(readlineParser({ delimiter: '\n' })).on('data', (line) => console.log(`< ${line.trimEnd()}`))

for await (const line of console) await port.write(`${line}\n`)
await port.close()
