/** Run `fetch`, hand the result to `apply`; on failure retry with doubling backoff up to `maxAttempts`
 *  tries in total, then give up quietly (the recap is reloaded when the panel is next opened).
 *  Returns a cancel function: nothing is applied or retried after it. */
export function startRefresh<T>(o: {
  fetch: () => Promise<T>
  apply: (value: T) => void
  maxAttempts: number
  baseMs: number
  /** Called once when the last attempt failed (not after cancel). */
  onGiveUp?: () => void
}): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = async (n: number): Promise<void> => {
    try {
      const value = await o.fetch()
      if (!cancelled) o.apply(value)
    } catch {
      if (cancelled) return
      if (n + 1 >= o.maxAttempts) {
        o.onGiveUp?.()
        return
      }
      timer = setTimeout(() => { void attempt(n + 1) }, o.baseMs * 2 ** n)
    }
  }
  void attempt(0)
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Tickets for overlapping loads: only the most recently issued one may apply its result. */
export function latestGate() {
  let n = 0
  return { next: () => ++n, isLatest: (t: number) => t === n }
}
