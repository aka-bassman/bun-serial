/** Anything with push(Uint8Array) can be piped to — that's all SerialPort.pipe() relies on. */
export interface Parser {
  push(chunk: Uint8Array): void
}

export interface ParserEvents<Message> {
  data: [message: Message]
}
