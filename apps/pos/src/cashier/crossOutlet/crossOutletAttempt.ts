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
}

export type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const ATTEMPT_KEY = 'mandalika.pos.crossOutletAttempt'

export interface AttemptStore {
  read(): PendingAttempt | null
  /** false when the tablet could not store it: the caller must NOT send. */
  write(a: PendingAttempt): boolean
  clear(): void
}

const isAttempt = (v: unknown): v is PendingAttempt => {
  const a = v as Partial<PendingAttempt> | null
  return !!a && typeof a.uuid === 'string' && typeof a.orderId === 'string' && typeof a.bodyJson === 'string'
}

export function createAttemptStore(storage?: AttemptStorage): AttemptStore {
  const st = (): AttemptStorage | null => {
    try { return storage ?? window.localStorage } catch { return null }
  }
  return {
    read() {
      try {
        const raw = st()?.getItem(ATTEMPT_KEY)
        if (!raw) return null
        const v: unknown = JSON.parse(raw)
        return isAttempt(v) ? { ...v, orderNumber: v.orderNumber ?? '' } : null
      } catch { return null }
    },
    write(a) {
      try {
        const s = st()
        if (!s) return false
        s.setItem(ATTEMPT_KEY, JSON.stringify(a))
        return s.getItem(ATTEMPT_KEY) !== null
      } catch { return false }
    },
    clear() {
      try { st()?.removeItem(ATTEMPT_KEY) } catch { /* nothing more to do */ }
    },
  }
}
