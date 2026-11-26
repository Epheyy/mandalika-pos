import { getKV, type KV } from '@mandalika/sync'

/** The one cross-outlet refund this tablet has sent (or is about to send) and not yet seen answered (A18).
 *  Written BEFORE the first send; the same uuid and byte-identical body are reused on every retry, so a lost answer can
 *  never become a second payout. Cleared only on a 2xx or a definite refusal. */
export interface PendingAttempt {
  uuid: string
  orderId: string
  orderNumber: string
  /** The exact JSON of the request body, resent as is. */
  bodyJson: string
  createdAt: string
  /** How many times this body has been (or is about to be) sent, counted BEFORE each send. 1 = the first send has not
   *  been answered yet; more = an earlier send went unanswered, so a 403/404/405 may be a change after it was applied. */
  sends: number
}

export const ATTEMPT_KEY = 'mandalika.pos.crossOutletAttempt'

export interface AttemptStore {
  read(): PendingAttempt | null
  /** Durable write: false when the tablet could not store it, and the caller must NOT send. */
  write(a: PendingAttempt): Promise<boolean>
  clear(): Promise<void>
}

const isAttempt = (v: unknown): v is PendingAttempt => {
  const a = v as Partial<PendingAttempt> | null
  return !!a && typeof a.uuid === 'string' && typeof a.orderId === 'string' && typeof a.bodyJson === 'string'
}

/** Reads are synchronous (the KV only shows values a durable write committed); writes are awaited. */
export function createAttemptStore(kv?: KV): AttemptStore {
  const store = (): KV | null => {
    try { return kv ?? getKV() } catch { return null }
  }
  return {
    read() {
      try {
        const raw = store()?.get(ATTEMPT_KEY)
        if (!raw) return null
        const v: unknown = JSON.parse(raw)
        // A record without a send count is from before it was tracked: treat it as already sent (the careful reading).
        return isAttempt(v) ? { ...v, orderNumber: v.orderNumber ?? '', sends: typeof v.sends === 'number' ? v.sends : 2 } : null
      } catch { return null }
    },
    async write(a) {
      try {
        const s = store()
        if (!s) return false
        await s.setDurable(ATTEMPT_KEY, JSON.stringify(a))
        return s.get(ATTEMPT_KEY) !== null
      } catch { return false }
    },
    async clear() {
      const s = store()
      if (!s) return
      try { await s.removeDurable(ATTEMPT_KEY) } catch {
        // Could not delete it: overwrite with an empty marker so a restart cannot resurrect a settled attempt.
        try { await s.setDurable(ATTEMPT_KEY, '') } catch { /* nothing more to do */ }
      }
    },
  }
}
