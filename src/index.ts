export { SerialPort, type SerialPortEvents } from './serial-port.js'
export { list } from './list.js'
export { SerialPortError, isSerialPortError, type SerialErrorCode } from './errors.js'
export type {
  DataBits,
  OpenOptions,
  Parity,
  ResolvedOpenOptions,
  SerialPortOptions,
  StopBits,
} from './options.js'
export type { WriteData } from './internal/bytes.js'
export type {
  Binding,
  BindingCapabilities,
  BindingPort,
  ModemLines,
  ModemStatus,
  PortInfo,
  UpdateOptions,
} from './bindings/types.js'
export * from './parsers/index.js'
