import type { ResolvedOpenOptions } from '../options.js'

type LineSettings = Pick<ResolvedOpenOptions, 'baudRate' | 'dataBits' | 'stopBits' | 'parity'>

/** Milliseconds one character takes on the wire: start bit, data, parity, stop bits. */
export function frameTimeMs(settings: LineSettings): number {
  const bits = 1 + settings.dataBits + (settings.parity === 'none' ? 0 : 1) + settings.stopBits
  return (bits * 1000) / settings.baudRate
}

/**
 * How long `byteCount` bytes should take to transmit, with headroom for
 * driver and USB scheduling. Used to tell a slow-but-moving device from a
 * wedged one when progress can't be observed directly.
 */
export function transmitBudgetMs(settings: LineSettings, byteCount: number): number {
  return lineTimeBudgetMs(byteCount * frameTimeMs(settings))
}

/** The same headroom, for output measured in line time rather than bytes. */
export function lineTimeBudgetMs(lineMs: number): number {
  return lineMs * 1.5 + 250
}

/** How many bytes the line carries in `ms`, at least one. */
export function bytesInMs(settings: LineSettings, ms: number): number {
  return Math.max(1, Math.floor(ms / frameTimeMs(settings)))
}
