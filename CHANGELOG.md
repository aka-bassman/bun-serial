# Changelog

## 0.9.0

### Minor Changes

- Add `MockDevice.reconnect()` to plug a disconnected mock device back in, so replug scenarios can be tested on one `MockBinding`. A port left open across the unplug stays `DISCONNECTED` and doesn't keep the device busy.
- Add `maxQueuedWrites`: past it, `write()` rejects with the new `QUEUE_FULL` code at once instead of queueing behind output the device isn't taking. `queuedWrites` reports how many writes are pending.
  
  Add `onListenerError(error, event)` to receive exceptions thrown by event listeners, including those of piped parsers, instead of having them rethrown as uncaught exceptions. A throwing listener no longer keeps the port's other listeners from running, and a parser now delivers every message of a chunk before rethrowing what its listeners threw (an `AggregateError` if several did).

## 0.8.0

First release: a TypeScript rewrite of [bun-serialport](https://github.com/fredrikpaulin/bun-serialport)
0.2.x (unreleased main) with Windows support. Requires Bun 1.4 or newer.

### Added
- Windows binding: the Win32 comm API through `bun:ffi` with overlapped I/O
  whose completions the system thread pool reports, so nothing polls and an
  idle port costs no CPU — reads that wait in the driver for the first byte,
  chunked writes with two in flight, `FlushFileBuffers` and `CloseHandle` on
  threads of their own, DTR/RTS changes ordered so ESP32 auto-reset circuits
  aren't tripped — and SetupAPI port enumeration with USB metadata (serial
  numbers of composite devices included), `pnpId` and `locationId`.
- macOS port enumeration through IOKit, with USB metadata (`vendorId`,
  `productId`, `serialNumber`, `manufacturer`, `product`, `locationId`).
- `BindingPort` contract and `MockBinding` (`bun-serial/mock`) for tests without hardware.
- `SerialPortError` with portable codes (`NOT_FOUND`, `BUSY`, `DISCONNECTED`, …)
  and the raw `osCode`.
- Mark and space parity on Linux and Windows; 1.5 stop bits on Windows.
- `writeTimeout` option; `await using` support; parser classes with `reset()`.

### Changed from bun-serialport
- Reads and writes no longer poll: one worker thread waits in epoll (Linux) or
  kqueue (macOS) for every open port, so an idle port costs no CPU, and data
  is seen within a fraction of a millisecond instead of up to `pollInterval`.
- `drain()` no longer blocks the event loop: `tcdrain` runs on a worker thread.
- macOS: writes and `close()` allow for the transmit buffer Apple's USB serial
  drivers keep beyond the kernel's queue (about 16 KB for FTDI) and for the
  FTDI driver's late drain, so large writes no longer fail `TIMEOUT` while the
  line is busy, and `close()` no longer cuts off their tail. Calls those
  drivers hold up behind a `tcdrain` in progress — `tcflush`, `close(2)`,
  modem-line ioctls — no longer run on the event loop's thread while one may
  be, so output held by flow control can't freeze the process.
- `close()` is bounded: stalled writes are abandoned, queued output gets as long
  as it should take to transmit, and the rest is discarded instead of hanging
  the process. On Linux, where `close(2)` waits up to 30 s for output the
  driver still holds — and `tcflush` can't discard what `cdc_acm` has handed
  to USB — a close with output still queued runs on a worker thread, and
  opening the device again before it finishes rejects `BUSY`.
- `update()` waits for writes queued before it, not just the kernel's queue.
- Options a platform can't honor throw `UNSUPPORTED` instead of being ignored.
- `write()` copies its data, so callers may reuse their buffer at once.
- `pollInterval` replaces `readInterval`.

### Fixed (also present in bun-serialport)
- `write()` followed by `close()` without an `await` lost the data, then wrote
  to the already-closed fd (EBADF — or to whatever file reused the number).
  Calls now join the output queue synchronously, so `close()` waits for them.
- `ioctl` on Apple Silicon: its variadic third argument was passed in a register
  where macOS never reads it, so modem-line calls and custom baud rates silently
  used a garbage pointer.
- Linux `list()` never found USB metadata: it climbed the `/sys/class` symlink
  instead of the device's real path.
- Linux `list()` no longer reports the 32 empty `ttyS*` slots of the 8250 driver.
- macOS rates above 230400 go through `IOSSIOSPEED` rather than `tcsetattr`,
  which drivers commonly reject.
- Opening a port no longer waits for output a previous user left queued
  (`TCSANOW` instead of `TCSAFLUSH`).
- A throwing `data` listener can no longer be mistaken for a disconnect.
