// emit() stops at the first listener that throws, so the listeners after it
// miss the event. SerialPort and the parsers call each listener on its own
// instead: one failing handler must not starve a pipe or drop messages.

import type { EventEmitter } from 'node:events'

const none: readonly unknown[] = Object.freeze([])

/** Call every listener of `event` in order, as emit() would; returns what they threw. */
export function emitEach(emitter: EventEmitter, event: string | symbol, args: readonly unknown[]): readonly unknown[] {
  let errors: unknown[] | undefined
  // rawListeners() is a snapshot, and calling a once() wrapper removes it — as in emit().
  for (const listener of emitter.rawListeners(event)) {
    try {
      Reflect.apply(listener, emitter, args)
    } catch (err) {
      errors ??= []
      errors.push(err)
    }
  }
  return errors ?? none
}

/** Throw the single error as is, several as an AggregateError. */
export function throwErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} listeners threw`)
}
