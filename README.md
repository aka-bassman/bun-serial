# bun-serial

Serial ports for [Bun](https://bun.sh) on Linux, macOS and Windows, in TypeScript.
`bun:ffi` calls straight into each OS's serial API — no native addon, no node-gyp,
no prebuilt binaries.

- **One API, three platforms.** termios on Linux and macOS; the Win32 comm API
  with overlapped I/O on Windows.
- **Never blocks the event loop, never polls.** The OS says when a port can
  be read or written — the system thread pool on Windows, one worker thread
  waiting in epoll or kqueue on Linux and macOS — so an idle port costs no
  CPU and data arrives within a fraction of a millisecond. `tcdrain`,
  `FlushFileBuffers` and a slow driver's close run on other threads.
- **Fails loudly.** Options a platform can't honor throw `UNSUPPORTED` instead of
  being ignored, and every error carries a portable code.
- **Typed** events and options, parsers, and an in-memory mock binding for tests.

## Install

```sh
bun add bun-serial
```

Requires Bun 1.4 or newer.

## Quick start

```ts
import { readlineParser, SerialPort } from 'bun-serial'

const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 })
port.on('error', (err) => console.error(err.code, err.message))
port.pipe(readlineParser()).on('data', (line) => console.log('received:', line))

await port.write('HELLO\n') // waits for the automatic open
```

Ports are `/dev/ttyUSB0`, `/dev/ttyACM0`, … on Linux, `/dev/cu.usbserial-…` on
macOS and `COM3`, `COM12`, … on Windows.

## Listing ports

```ts
import { list } from 'bun-serial'

for (const port of await list()) {
  console.log(port.path, port.manufacturer, port.vendorId, port.productId, port.serialNumber)
}
```

| Field          | Linux                       | macOS               | Windows                     |
| -------------- | --------------------------- | ------------------- | --------------------------- |
| `path`         | `/dev/ttyUSB0`              | `/dev/cu.usbserial-110` | `COM3`                  |
| `vendorId`, `productId`, `serialNumber`, `manufacturer`, `product` | sysfs | IOKit | SetupAPI |
| `pnpId`        | `/dev/serial/by-id` name    | —                   | device instance ID          |
| `locationId`   | USB devpath (`1-1.4`)       | `locationID` (hex)  | location information        |

## API

### `new SerialPort(options)`

| Option            | Default    | |
| ----------------- | ---------- | - |
| `path`            | required   | Port to open. |
| `baudRate`        | required   | Any positive integer. Rates outside the classic table use `termios2` (Linux), `IOSSIOSPEED` (macOS) or the driver directly (Windows). |
| `dataBits`        | `8`        | `5`, `6`, `7`, `8` |
| `stopBits`        | `1`        | `1`, `2`; `1.5` on Windows (with 5 data bits) |
| `parity`          | `'none'`   | `'none'`, `'even'`, `'odd'`; `'mark'`, `'space'` on Linux and Windows. Bytes failing the check are dropped. |
| `rtscts`          | `false`    | Hardware flow control. |
| `xon` / `xoff`    | `false`    | Software flow control: honor / send XON/XOFF. |
| `xany`            | `false`    | Any received byte restarts output (not on Windows). |
| `hupcl`           | `true`     | Drop DTR/RTS on close. `false` keeps Arduino-style boards from resetting (see [Windows](#windows)). |
| `lock`            | `true`     | Exclusive access. `false` allows sharing (not on Windows, where COM ports are always exclusive). |
| `autoOpen`        | `true`     | Open on the next microtask. Methods called before then wait for it. |
| `readBufferSize`  | `65536`    | Bytes per read. |
| `pollInterval`    | `1`        | How often to check the OS where it can't say when a port is ready, in ms: `drain()` on Windows, and fallbacks. Rarely worth changing. |
| `writeTimeout`    | `1000`     | How long a write may stall — the OS taking no bytes when it should have room — before it rejects `TIMEOUT`. On macOS the clock starts once the output already handed over should be out (see [macOS](#macos)). `Infinity` waits forever. |
| `maxQueuedWrites` | `Infinity` | Most `write()` calls pending at once, queued or in progress. Past it, `write()` rejects `QUEUE_FULL` at once instead of queueing behind output the device isn't taking, where each write would wait out `writeTimeout` in turn. |
| `onListenerError` | —          | `(error, event) => void`: receives exceptions thrown by event listeners, piped parsers' included (see [Events](#events)). |
| `binding`         | platform   | Swap in another binding, e.g. `MockBinding` in tests. |

Invalid options throw `INVALID_ARGUMENT` from the constructor; valid options the
platform can't honor throw `UNSUPPORTED`.

### Methods

All return promises.

- `open()` — only needed with `autoOpen: false`.
- `close()` — lets queued output finish, then closes. Output the device has
  stopped taking is abandoned instead of waited on forever.
- `write(data)` — `string` (UTF-8), `Uint8Array`, `ArrayBuffer`, any typed array
  or `DataView`, or an array of bytes. Resolves once the OS has accepted every
  byte. Writes never interleave, and the data is copied, so the buffer can be
  reused at once.
- `drain()` — resolves once everything written so far has been transmitted.
- `update({ baudRate })` — changes the rate once earlier output is out.
- `set({ dtr, rts, brk })` — sets the output lines and the break condition;
  omitted keys are left alone.
- `get()` — `{ cts, dsr, dcd, ri }`.
- `flush()` — discards unread input and untransmitted output.
- `pipe(parser)` / `unpipe(parser)` — feed incoming data to a parser.

Properties: `path`, `baudRate`, `isOpen`, `queuedWrites` (`write()` calls not
yet settled). `await using port = new SerialPort(…)` closes the port when the
scope ends.

### Events

| Event   | Payload                    | |
| ------- | -------------------------- | - |
| `open`  | —                          | |
| `data`  | `Uint8Array`               | |
| `error` | `SerialPortError`          | A failed `autoOpen`, or a failed read — usually code `DISCONNECTED`, after which the port closes. |
| `close` | `SerialPortError \| undefined` | Carries the error when a failed read caused the close; nothing after `close()`. |

A listener that throws doesn't keep the others from running, and the port keeps
reading. The exception goes to `onListenerError` if given, and otherwise
surfaces as an uncaught exception. That includes the listeners of a piped
parser: a parser delivers every message of a chunk, then rethrows what its
listeners threw (an `AggregateError` if several did). An `error` event with no
listener is uncaught either way, as with any `EventEmitter`.

### Errors

Every failure is a `SerialPortError` with a portable `code`, plus `syscall` and
the raw `osCode` (errno or Win32 error) where one exists.

| Code               | Meaning |
| ------------------ | ------- |
| `INVALID_ARGUMENT` | Malformed option or argument; also a path that isn't a serial port. |
| `UNSUPPORTED`      | Valid, but not on this platform, binding or device. |
| `NOT_FOUND`        | No such port. |
| `ACCESS_DENIED`    | No permission (Linux: add yourself to the `dialout` group). |
| `BUSY`             | Another process holds the port, or its driver is still busy with a close (macOS: or a drain) of this one. |
| `NOT_OPEN`, `ALREADY_OPEN` | Wrong state for the call. |
| `DISCONNECTED`     | The device went away. |
| `CANCELED`         | Interrupted by `close()`. |
| `TIMEOUT`          | A write stalled for `writeTimeout` ms. |
| `QUEUE_FULL`       | `write()` with `maxQueuedWrites` already pending. |
| `IO`               | Any other OS failure. |

```ts
import { isSerialPortError } from 'bun-serial'

try {
  await port.open()
} catch (err) {
  if (isSerialPortError(err, 'BUSY')) console.log('close the other program using the port')
  else throw err
}
```

### Parsers

```ts
import { byteLengthParser, delimiterParser, readlineParser } from 'bun-serial' // or 'bun-serial/parsers'

port.pipe(readlineParser({ delimiter: '\r\n' })).on('data', (line: string) => {})
port.pipe(delimiterParser({ delimiter: [0x7e], includeDelimiter: true })).on('data', (frame: Uint8Array) => {})
port.pipe(byteLengthParser({ length: 8 })).on('data', (chunk: Uint8Array) => {})
```

A parser is anything with `push(chunk: Uint8Array)`.

### Testing without hardware

```ts
import { MockBinding } from 'bun-serial/mock'

const binding = new MockBinding()
const device = binding.addPort('/dev/mock0')
const port = new SerialPort({ path: '/dev/mock0', baudRate: 9600, binding })

device.emit('OK\r\n')               // the device sends
await port.write('AT\r\n')
device.takeWritten()                // what the port wrote
device.setStalled(true)             // the device stops taking output
device.disconnect()                 // unplug
device.reconnect()                  // plug back in; open() works again
```

## Platform notes

### Linux and macOS

While any port is open, one worker thread (a few MB) waits in `epoll_wait`
(Linux) or `kevent` (macOS) for all of them; each port arms a one-shot wait
when a read or write would block. It stops when the last port closes.
`tcdrain` runs on a worker thread of its own, and so does `close(2)` when it
could block: on Linux when output is still queued, on macOS (with `tcflush`)
when a `tcdrain` may hold it up.

### Linux

Ports are found through sysfs; empty `ttyS*` slots registered by the 8250
driver are skipped. Arbitrary baud rates use `termios2`. Works with glibc and
musl.

`close(2)` waits — up to 30 s, the kernel's `closing_wait` — for output the
driver still holds, and `tcflush` can't reach everything: `cdc_acm` keeps
what it has already handed to USB (about 9 KB of a 16 KiB write at 9600 still
went out after a `flush()`). So when a device has stopped taking output,
`close(2)` runs on a worker thread: `close()` waits a second for it and leaves
the rest to the kernel, and opening the device meanwhile rejects `BUSY`.

### macOS

Use the `/dev/cu.*` callout devices (`list()` returns those). Rates other than
the BSD table (above 230400, among others) go through `IOSSIOSPEED`.

Apple's USB serial drivers keep a transmit buffer of their own — about 16 KB
in the FTDI driver, 2 KB in the CDC-ACM one — that the kernel's queue count
leaves out, and refill it only once it is nearly empty, so a busy port can
refuse every byte for over a second at 115200 while its line never stops. The
port therefore counts the line time of everything the OS has taken: a write
counts as stalled, and a `close()` gives up on queued output, only once that
output should have gone out. The FTDI driver also reports a drain as if each
character took 12 bits rather than 10, so after a long transfer `drain()` —
and `close()`, which drains — resolves about 20% of its line time late.

While a `tcdrain` is in progress the same drivers hold up `tcflush`,
`close(2)`, the modem-line ioctls and even `open(2)` of the device — for
good, if flow control holds the output. So none of those runs on the event
loop's thread while one may be: `flush()` and `close()` hand theirs to a
worker thread and wait a second at most (a `flush()` that gives up rejects
`IO`, though the flush may still happen later; `close()` leaves the rest to
the driver), `set()` and `get()` wait for the drain first, and opening the
device meanwhile rejects `BUSY`.

Known driver issues:
- If Apple's FTDI driver is closed with output it never sent — held by
  hardware flow control, or abandoned mid-transfer — it stops transmitting
  until the adapter is unplugged, and that close itself completes only then.
  Let output drain (or keep flow control released) before closing.
- Bytes received but not read before a close can arrive after the next open;
  the flush on open doesn't reach what the driver holds.

### Windows

- Paths are `COM3`, `COM12`, …; the `\\.\` prefix is added for you.
- COM ports are always exclusive, so `lock: false` throws `UNSUPPORTED`; so does
  `xany`, which has no Windows equivalent.
- Windows drivers drop DTR when a port closes whatever the settings, so
  `hupcl: false` instead keeps DTR and RTS deasserted from the moment the port
  opens — the only way to avoid resetting Arduino-style boards, which reset on
  a DTR edge (node-serialport makes the same choice). Devices that need DTR can
  still get it with `set({ dtr: true })`.
- DTR and RTS change one at a time and never pass through DTR down with RTS up
  unless asked to: that state holds an ESP32/ESP8266 auto-reset circuit in
  reset. Opening (DTR first, then RTS), `set()`, `update()` and `close()`
  therefore leave such boards running with either `hupcl` setting, while
  esptool-style reset sequences through `set()` still work.
- With `rtscts`, RTS belongs to the driver: `set({ rts })` throws `UNSUPPORTED`.
- Windows has no setting to drop bytes that fail the parity check; they are
  delivered.
- Nothing polls for incoming data: a read waits in the driver for the first
  byte, and the system thread pool reports its completion
  (`RegisterWaitForSingleObject`, with Bun carrying the news to the JavaScript
  thread). An open port costs no CPU while idle, and an ESP32-S3's bootloader
  answered requests in under a millisecond on average. `pollInterval` only
  paces `drain()`'s checks of the driver's queue, and reads on a driver that
  ignores the read timeouts.
- `drain()` resolves once the driver has handed everything to the adapter. The
  adapter's own buffer may still be going out — on an FT232R about 128 bytes,
  which is 133 ms at 9600 baud and 11 ms at 115200. Closing the port doesn't
  stop it, but changing the baud rate, dropping RTS to turn an RS-485
  transceiver around, or reopening the port in that time cuts it short.
- An FTDI driver takes about 110 ms to close a port. `CloseHandle`, like
  `FlushFileBuffers`, runs on a thread of its own, so the event loop carries
  on meanwhile.

### Verification status

Linux (glibc and musl, x64 and arm64) and macOS run the full suite against real
kernel ttys, including an idle port making no system calls and a stalled write
making none until the tty has room. On Windows, `tests/win32-pipe.test.ts` runs the binding over
named pipes — real overlapped `ReadFile`/`WriteFile`, `CancelIoEx`,
thread-pool waits and `FlushFileBuffers` on real handles, with only the
comm-specific calls simulated — covering data integrity, stalls, timeouts,
bounded `close()`, an idle port that never polls, and handle leaks. It passes
on Windows 11 with Bun 1.4.0 and 1.4.2.
The binding has also run on Windows 11 against real adapters: an FT232R
(FTDI's driver) with TX wired to RX, and the CH343 of an ESP32-S3 board
(WCH's driver) — the settings each driver accepts, echo from 9600 to 921600
baud and a 64 KiB transfer, write and drain timing against the echo,
flow-control stalls, `BUSY`, unplugging and replugging mid-transfer,
enumeration, and with the ESP32-S3 its ROM boot log and a request and
response conversation with its ROM bootloader at 115200 and 921600 baud. To
check your own adapter, run `bun examples/loopback.ts COM3` with a loopback
plug (TX wired to RX), and please report the result.

On macOS (Apple Silicon) the same two adapters have run under Apple's own
drivers: the FT232R (DriverKit FTDI) with echo from 9600 to 921600 baud, a
10 s stream at 921600, 30 open/close cycles, writes far larger than the
driver's buffer at 19200 with the default `writeTimeout`, `close()` during and
right after large writes (every byte delivered, nothing left for the next
open), drain timing against the echo, output held by flow control, unplugging
mid-transfer with a drain in progress and replugging, and a soak of random
writes, drains and modem-line calls; the ESP32-S3's CH343 (CDC-ACM) with its
ROM bootloader at 115200 and 921600 baud, alone and alongside the FT232R
stream, and large writes while the chip is held in reset.

On Linux (a Radxa ZERO 3W: arm64, Debian 12, kernel 6.1) the ESP32-S3's CH343
has run under `cdc_acm`, talking to its ROM bootloader: enumeration through
sysfs, rate changes from 230400 to 3000000 baud including `termios2` rates,
pipelined register reads at up to 3 Mbaud with every reply checked, RAM loads
in 6 KiB blocks verified by the ROM's checksums, large writes and `close()`
right after them with the chip held in reset, output the adapter stopped
taking (a write's `TIMEOUT`, then `close()`), the lock against another
process, open/close cycles, a 10-minute soak (31 MiB checked), unplugging
mid-transfer and reopening by its `/dev/serial/by-id` link in the same
process, and a compiled binary.

### Known limitations

- On Windows, `drain()` can't see into the adapter's own buffer (see
  [Windows](#windows)).
- Opening a Bluetooth COM port on Windows blocks while Windows connects to the
  device (`CreateFileW` has no asynchronous form).
- On macOS, Apple's FTDI driver stops transmitting if closed with output it
  never sent, until the adapter is replugged (see [macOS](#macos)).
- A WCH CH343 reports a drain 40–130 ms before the line time is up, under
  Linux and macOS alike: the chip still holds the last bytes (about 120 at
  9600 baud, 500 at 115200). A baud rate change or an RS-485 turnaround
  straight after `drain()` can cut them off.
- Adapters can stop sending at rates the driver accepts: a CH343 under Linux's
  `cdc_acm` took 400000, 1152000 and 1843200 baud and then sent nothing, so
  writes timed out (250000, 256000 and the usual rates up to 3000000 worked).
  Try an unusual rate on your adapter before relying on it.

## How it works

`SerialPort` is platform-neutral: it owns the open/close lifecycle, a read loop
that turns `BindingPort.read()` into `data` events, and an output chain that
keeps `write()`, `drain()` and `update()` in call order. Each platform
implements the small `BindingPort` contract in
[`src/bindings/types.ts`](src/bindings/types.ts).

- **Reads** take what the non-blocking fd has, and when it has nothing, wait
  for the poller worker to report it readable (POSIX); or issue overlapped
  `ReadFile`s that wait in the driver for the first byte while the system
  thread pool waits for their completion (Windows).
- **Writes** hand bytes to the OS without blocking. On POSIX a full kernel
  buffer means "stalled" — on macOS only once the output the OS holds should
  have gone out — and the write waits for the poller to report room. On
  Windows, writes go out in chunks of about 200 ms
  of line time with two queued in the driver at once, and a chunk counts as
  stalled once it has outlasted its own transmission time.
- **`drain()`** runs `tcdrain` on a worker thread (POSIX), or waits for the
  driver's output queue to empty and then runs `FlushFileBuffers` on a thread
  of its own (Windows).
- **`close()`** waits for writes in progress, abandons stalled ones, drains
  queued output for as long as it should take to transmit, discards whatever is
  left, and releases the port. Where `close(2)` could still block — on Linux
  for up to 30 s on output the driver holds, on macOS behind a `tcdrain` — it
  runs on a worker thread. On Windows the handle is closed on a thread of its
  own, since some drivers take 100 ms or more.

## Development

```sh
bun install
bun run typecheck
bun test                   # pty tests on Linux and macOS, named-pipe tests on Windows, a simulated Windows driver everywhere
bun run build              # dist/
bun run typecheck:consumer # checks dist/*.d.ts as a strict consumer would
```

Linux from macOS: `docker run --rm -v "$PWD":/work -w /work oven/bun:1.4.2 bun test`.
After a build, `bun tests/helpers/dist-smoke.ts` checks the built package on a
pty.

Releases go through [Changesets](https://changesets.dev), run by hand:

```sh
bun run changeset               # with each change: pick patch/minor/major, describe it
bun run publish:npm --dry-run   # rehearsal: the changesets applied, the checks, npm publish --dry-run; changes nothing
bun run publish:npm             # apply the changesets, run the checks, commit the bump, npm publish, tag, push
```

`publish:npm` (`scripts/release.ts`) first checks that you are on `main` with
a clean tree and logged in to npm, runs the checks above (`prepublishOnly`),
and asks before publishing; the npm one-time password is asked for last, so
it is still valid when npm sends it. If the publish fails, fix the cause and
run it again: it carries on from the committed version.
`bun run version-packages` only applies the changesets.

## Credits

The POSIX binding is a port of [bun-serialport](https://github.com/fredrikpaulin/bun-serialport)
by Fredrik Paulin, and the Windows enumeration builds on the
[windows-support branch](https://github.com/malteheringOrgatex/bun-serialport/tree/windows-support)
by Malte Hering. Platform behavior follows
[node-serialport](https://github.com/serialport/bindings-cpp) and
[pyserial](https://github.com/pyserial/pyserial) where they agree.

## License

MIT — see [LICENSE](LICENSE).
