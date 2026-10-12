// Holds the process open while a port waits on something Bun's event loop
// can't see — a wait in the Windows thread pool, a worker blocked in
// epoll_wait or kevent — the way an open socket would: a timer that never
// fires, referenced while any such wait is outstanding.

let timer: ReturnType<typeof setInterval> | undefined
let holds = 0

export function holdOpen(): void {
  if (holds++ === 0) (timer ??= setInterval(() => {}, 2 ** 31 - 1)).ref()
}

export function letGo(): void {
  if (--holds === 0) timer?.unref()
}
