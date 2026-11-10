// Serializes print jobs: two prints must never share one socket. A rejected
// job does not block the next one.

let tail: Promise<unknown> = Promise.resolve()

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn)
  tail = run.catch(() => undefined)
  return run
}
