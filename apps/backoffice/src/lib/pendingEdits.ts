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

export interface LineSaverDeps {
  /** Latest pending edits (a ref mirror, never a stale render closure). */
  getEdits: () => PendingEdits
  setEdits: (fn: (d: PendingEdits) => PendingEdits) => void
  send: (scId: string, key: string, value: number | null) => Promise<void>
  /** Re-read the list so the saved value is in the fresh data. */
  refresh: () => Promise<void>
}

/**
 * Saves one count line at a time per line. Its turn sends the latest pending value;
 * after the server accepted it the list is refreshed and only then is the edit
 * cleared (and only if it still holds the sent value), so the input never reverts
 * to stale data and a newer keystroke is never lost. A failed send rejects and
 * leaves the edit pending.
 */
export function createLineSaver(deps: LineSaverDeps) {
  const queue = createKeyedQueue()
  return {
    save: (scId: string, key: string): Promise<void> =>
      queue.run(`${scId}|${key}`, async () => {
        const sent = deps.getEdits()[scId]?.[key]
        if (sent === undefined) return
        await deps.send(scId, key, sent)
        try {
          await deps.refresh()
        } catch {
          // Saved on the server; the next poll catches the list up.
        }
        deps.setEdits((d) => settleEdit(d, scId, key, sent))
      }),
  }
}

/** Complete only after everything pending was saved; false = stopped, nothing completed. */
export async function completeAfterFlush(
  flush: () => Promise<boolean>,
  complete: () => Promise<void>,
): Promise<boolean> {
  if (!(await flush())) return false
  await complete()
  return true
}
