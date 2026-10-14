/** Unsaved stock-count edits: count id -> line key -> counted qty (null = cleared). */
export type PendingEdits = Record<string, Record<string, number | null>>

/**
 * Forget a pending edit after a save succeeded, but only if it still holds the value
 * that was sent: a newer value typed while the request was in flight must survive.
 */
export function settleEdit(edits: PendingEdits, scId: string, key: string, sent: number | null): PendingEdits {
  const lines = edits[scId]
  if (!lines || !(key in lines) || lines[key] !== sent) return edits
  const rest = { ...lines }
  delete rest[key]
  return { ...edits, [scId]: rest }
}

/**
 * Serialises async work per key (one in-flight save per line) while letting
 * different keys run in parallel. A failed run rejects to its own caller only.
 */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve()
      const result = prev.then(task, task)
      const tail = result.catch(() => undefined)
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
  }
}
