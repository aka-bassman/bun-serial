// Hardware check with a loopback plug: wire TX to RX (and, optionally, RTS to
// CTS and DTR to DSR). Exercises open, echo at several baud rates, a large
// transfer, update(), drain(), modem lines and close() on a real adapter —
// the way to verify a platform binding on actual hardware.
//
//   bun examples/loopback.ts COM3
//   bun examples/loopback.ts /dev/ttyUSB0
//   bun examples/loopback.ts /dev/cu.usbserial-110

import { isSerialPortError, list, SerialPort } from '../src/index.js'

const path = process.argv[2]
if (!path) {
  console.log('usage: bun examples/loopback.ts <port>\n\nports on this machine:')
  for (const port of await list()) console.log(`  ${port.path}  ${[port.manufacturer, port.product].filter(Boolean).join(' ')}`)
  process.exit(1)
}

const results: { name: string; ok: boolean; detail: string }[] = []
async function step(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run()
    results.push({ name, ok: true, detail })
    console.log(`PASS  ${name}  ${detail}`)
  } catch (err) {
    const detail = isSerialPortError(err) ? `${err.code}: ${err.message}` : String(err)
    results.push({ name, ok: false, detail })
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

const port = new SerialPort({ path, baudRate: 9600, autoOpen: false })
const received: Uint8Array[] = []
let waiter: (() => void) | null = null
port.on('data', (chunk) => {
  received.push(chunk)
  waiter?.()
})
port.on('error', (err) => console.log(`error event: ${err.code} ${err.message}`))

function take(): Uint8Array {
  const total = received.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of received.splice(0)) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function echo(bytes: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  take()
  const started = performance.now()
  await port.write(bytes)
  const deadline = started + timeoutMs
  while (received.reduce((sum, chunk) => sum + chunk.length, 0) < bytes.length && performance.now() < deadline) {
    await new Promise<void>((resolve) => {
      waiter = resolve
      setTimeout(resolve, 20)
    })
  }
  waiter = null
  return take()
}

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff)
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

await step('open', async () => {
  await port.open()
  return `${path} at 9600 baud`
})

if (port.isOpen) {
  for (const baudRate of [9600, 115200, 250000, 921600]) {
    await step(`echo at ${baudRate}`, async () => {
      await port.update({ baudRate })
      const sent = pattern(256)
      const started = performance.now()
      const got = await echo(sent, 3000)
      if (!same(sent, got)) throw new Error(`sent ${sent.length} bytes, got back ${got.length}`)
      return `${(performance.now() - started).toFixed(1)} ms round trip`
    })
  }

  await step('64 KiB transfer at 115200', async () => {
    await port.update({ baudRate: 115200 })
    const sent = pattern(65536)
    const started = performance.now()
    const got = await echo(sent, 15000)
    if (!same(sent, got)) throw new Error(`sent ${sent.length} bytes, got back ${got.length}`)
    return `${((sent.length * 8) / (performance.now() - started)).toFixed(1)} kbit/s`
  })

  await step('drain', async () => {
    await port.write(pattern(1024))
    const started = performance.now()
    await port.drain()
    take()
    return `${(performance.now() - started).toFixed(1)} ms`
  })

  await step('modem lines', async () => {
    await port.set({ dtr: true, rts: true })
    const high = await port.get()
    await port.set({ dtr: false, rts: false })
    const low = await port.get()
    await port.set({ dtr: true, rts: true })
    return `with RTS/DTR up: ${JSON.stringify(high)}; down: ${JSON.stringify(low)} (CTS/DSR follow only if jumpered)`
  })

  await step('break', async () => {
    await port.set({ brk: true })
    await Bun.sleep(20)
    await port.set({ brk: false })
    await Bun.sleep(20)
    take()
    return 'asserted and cleared'
  })

  await step('close', async () => {
    const started = performance.now()
    await port.close()
    return `${(performance.now() - started).toFixed(1)} ms`
  })

  await step('reopen and close', async () => {
    await port.open()
    await port.close()
    return 'ok'
  })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed on ${process.platform}/${process.arch}, Bun ${Bun.version}`)
process.exit(failed.length === 0 ? 0 : 1)
