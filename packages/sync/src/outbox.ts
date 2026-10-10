import type { KV } from './storage'

const OUTBOX_KEY = 'mandalika.pos.outbox'
/** An unreadable outbox is copied here (never deleted) before anything can overwrite it. */
export const OUTBOX_QUARANTINE_PREFIX = 'mandalika.outbox.corrupt.'
/** Durable marker (JSON OutboxCorruption) so the warning outlives the session that detected it.
 *  Deliberately NOT under the quarantine prefix. Nothing clears it yet (admin follow-up). */
export const OUTBOX_CORRUPTION_MARKER_KEY = 'mandalika.outbox.corruptionNotice'

export type OutboxType =
  | 'order'
  | 'refund'
  | 'shift_open'
  | 'shift_close'
  | 'cash_flow'
  | 'customer_create'
  | 'transfer_receive'

export type OutboxStatus = 'pending' | 'sent' | 'acked' | 'failed'

export interface OutboxItem {
  /** `${deviceId}:${orderUuid}` — globally unique, server-side unique key. */
  idempotencyKey: string
  type: OutboxType
  payload: Record<string, unknown>
  seq: number
  status: OutboxStatus
  clientCreatedAt: string
  lastError?: string
  /** Server-rejection count. After MAX_ATTEMPTS the item is parked (kept,
   *  surfaced via deadLettered()) so one poison item can't block the queue
   *  or retry forever silently. */
  attempts?: number
  /** Consecutive server results with `retryable: true`. These never count toward
   *  MAX_ATTEMPTS (the item keeps retrying) but flag it for attention at
   *  RETRYABLE_ATTENTION_AFTER. Additive: older bundles ignore it. */
  retryableFailures?: number
  /** "Needs review" state, stored rollback-safe: the item is `status: 'failed'` with
   *  `attempts >= MAX_ATTEMPTS`, which the previous bundles' `pending()` already treats
   *  as parked (not resent, not deleted). These two fields only say WHY. Server code
   *  (e.g. `competing_receipt`) or a client reason (`batch_rejected`). Additive. */
  reviewCode?: string
  reviewReason?: string
}

/** After this many consecutive retryable failures an item is reported and shown
 *  as needing attention, while it keeps retrying. */
export const RETRYABLE_ATTENTION_AFTER = 10

/** A server rejection that recurs this many times is treated as permanent. */
export const MAX_ATTEMPTS = 5

/** The stored outbox could not be parsed; its raw bytes were quarantined. */
export interface OutboxCorruption {
  quarantineKey: string
  detectedAt: string
}

/** One settled-result update applied by {@link Outbox.settle}. */
export type OutboxSettle =
  | { key: string; op: 'ack' }
  | { key: string; op: 'discard' }
  // retryable === true: record the error but do not count it toward MAX_ATTEMPTS.
  | { key: string; op: 'fail'; error: string; retryable?: boolean }
  // Park for human review right now (no 5-attempt wait). Never auto-retried or deleted.
  | { key: string; op: 'review'; code: string; reason: string }

/** A parked item as shown to the cashier. */
export interface ReviewItem {
  idempotencyKey: string
  type: OutboxType
  clientCreatedAt: string
  /** Unset for items parked by the old attempt counting (older server). */
  reviewCode?: string
  reviewReason?: string
  lastError?: string
}

/** Secrets must not outlive their use in a parked item (WebView-debuggable storage).
 *  The approver PIN of a transfer_receive is only needed for the send itself. */
function stripSecrets(item: OutboxItem): OutboxItem {
  if (item.type !== 'transfer_receive' || !('pin' in item.payload)) return item
  const payload = { ...item.payload }
  delete payload.pin
  return { ...item, payload }
}

function readMarker(kv: KV): OutboxCorruption | null {
  const raw = kv.get(OUTBOX_CORRUPTION_MARKER_KEY)
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as Partial<OutboxCorruption>
    if (typeof m.quarantineKey === 'string' && typeof m.detectedAt === 'string') {
      return { quarantineKey: m.quarantineKey, detectedAt: m.detectedAt }
    }
  } catch {
    /* unreadable marker: fall through and still warn */
  }
  return { quarantineKey: 'unknown', detectedAt: 'unknown' }
}

// Append-only durable queue. Survives app restart/crash (plan §5). Ordered by
// monotonic seq; flushed one in flight at a time.
//
// Every mutation goes through ONE serialized promise chain: the next whole
// array is computed inside the chain, written with `kv.setDurable`, and only
// then does `this.items` change. So `pending()` (and therefore flush) only
// ever sees committed items, a rejected write leaves no trace, and the
// whole-array writes can never land out of order.
export class Outbox {
  private items: OutboxItem[]
  private seqCounter: number
  private tail: Promise<void> = Promise.resolve()
  private corruption: OutboxCorruption | null = null
  // Resolves once the quarantine copy and marker (if any) are durably written;
  // rejects if they could not be, in which case NO outbox write may ever proceed.
  private ready: Promise<void> = Promise.resolve()
  // Once disposed (engine replaced after logout), this instance must never write
  // the outbox key: a stale whole-array write would drop items the live instance committed.
  private disposed = false

  constructor(private kv: KV) {
    const raw = kv.get(OUTBOX_KEY)
    let items: OutboxItem[] = []
    if (raw) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = undefined
      }
      if (Array.isArray(parsed)) {
        items = parsed as OutboxItem[]
      } else {
        const detectedAt = new Date().toISOString()
        const quarantineKey = OUTBOX_QUARANTINE_PREFIX + detectedAt
        this.corruption = { quarantineKey, detectedAt }
        const info = this.corruption
        this.ready = kv
          .setDurable(quarantineKey, raw)
          .then(() => kv.setDurable(OUTBOX_CORRUPTION_MARKER_KEY, JSON.stringify(info)))
        this.ready.catch(() => {}) // surfaced by commit(); avoid an unhandled rejection
      }
    }
    if (!this.corruption) this.corruption = readMarker(kv)
    this.items = items
    this.seqCounter = items.reduce((m, i) => Math.max(m, i.seq), 0)
  }

  /** Make every later mutation on this instance a no-op / rejection. Reversible
   *  only through {@link revive} (React StrictMode re-runs effects on one engine). */
  dispose(): void {
    this.disposed = true
  }

  revive(): void {
    this.disposed = false
  }

  /** Resolves true when there is nothing to quarantine or the quarantine copy
   *  was durably written; false if that write failed. */
  quarantineResult(): Promise<boolean> {
    return this.ready.then(() => true, () => false)
  }

  /** Set when the stored queue was unreadable and quarantined (now or on an
   *  earlier boot, via the durable marker). */
  corruptionInfo(): OutboxCorruption | null {
    return this.corruption
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Write `next` durably, then (only on success) make it the live queue. */
  private async commit(next: OutboxItem[]): Promise<void> {
    if (this.disposed) throw new Error('outbox disposed')
    await this.ready
    if (this.disposed) throw new Error('outbox disposed')
    await this.kv.setDurable(OUTBOX_KEY, JSON.stringify(next))
    this.items = next
  }

  /** Best-effort mutation: server receipts make a resend safe, so a failed
   *  write is logged and the in-memory queue is simply left unchanged. */
  private mutate(fn: (items: OutboxItem[]) => OutboxItem[] | null): Promise<void> {
    return this.run(async () => {
      if (this.disposed) return
      const next = fn(this.items)
      if (!next) return
      try {
        await this.commit(next)
      } catch (err) {
        if (this.disposed) return
        console.error('[outbox] write failed; queue unchanged', err)
      }
    })
  }

  /** Durably append. Resolves with the item only after it is on disk; rejects
   *  (leaving no trace) if the write fails. Same key twice returns the first. */
  add(type: OutboxType, idempotencyKey: string, payload: Record<string, unknown>): Promise<OutboxItem> {
    return this.run(async () => {
      const existing = this.items.find((i) => i.idempotencyKey === idempotencyKey)
      if (existing) return existing // never enqueue the same key twice
      const item: OutboxItem = {
        idempotencyKey,
        type,
        payload,
        seq: this.seqCounter + 1,
        status: 'pending',
        clientCreatedAt: new Date().toISOString(),
      }
      await this.commit([...this.items, item])
      this.seqCounter = item.seq
      return item
    })
  }

  /** Items still needing delivery, in submission order. Parked (repeatedly
   *  rejected) items are excluded so they neither block the queue nor retry
   *  forever — they remain visible via {@link deadLettered}. */
  pending(): OutboxItem[] {
    return this.items
      .filter(
        (i) =>
          i.status !== 'acked' &&
          !(i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS),
      )
      .sort((a, b) => a.seq - b.seq)
  }

  /** Permanently-rejected items needing manual attention (never auto-retried).*/
  deadLettered(): OutboxItem[] {
    return this.items.filter(
      (i) => i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS,
    )
  }

  /** Parked items in display form: explicit reviews plus legacy attempt-count parks. */
  reviewItems(): ReviewItem[] {
    return this.deadLettered().map((i) => ({
      idempotencyKey: i.idempotencyKey,
      type: i.type,
      clientCreatedAt: i.clientCreatedAt,
      reviewCode: i.reviewCode,
      reviewReason: i.reviewReason ?? i.lastError,
      lastError: i.lastError,
    }))
  }

  /** Still-retrying items that failed retryably at least RETRYABLE_ATTENTION_AFTER
   *  times in a row: likely a deterministic server problem, not a blip. */
  stuckRetrying(): OutboxItem[] {
    return this.pending().filter((i) => (i.retryableFailures ?? 0) >= RETRYABLE_ATTENTION_AFTER)
  }

  count(): number {
    return this.pending().length
  }

  /** Apply many server results with ONE write (a per-item whole-array rewrite
   *  would be O(n²) on a long offline queue). Best-effort, see {@link mutate}. */
  settle(updates: readonly OutboxSettle[]): Promise<void> {
    if (!updates.length) return Promise.resolve()
    return this.mutate((items) => {
      const byKey = new Map(updates.map((u) => [u.key, u]))
      let changed = false
      const next: OutboxItem[] = []
      for (const it of items) {
        const u = byKey.get(it.idempotencyKey)
        if (!u) {
          next.push(it)
        } else if (u.op === 'discard') {
          changed = true
        } else if (u.op === 'ack') {
          changed = true
          next.push({ ...it, status: 'acked' })
        } else if (u.op === 'review') {
          changed = true
          const parked: OutboxItem = {
            ...stripSecrets(it),
            status: 'failed',
            lastError: u.reason,
            // >= MAX_ATTEMPTS is what keeps older bundles from resending or deleting it.
            attempts: Math.max(it.attempts ?? 0, MAX_ATTEMPTS),
            reviewCode: u.code,
            reviewReason: u.reason,
          }
          delete parked.retryableFailures
          next.push(parked)
        } else {
          changed = true
          const retryable = u.retryable === true
          const failed: OutboxItem = {
            ...it,
            status: 'failed',
            lastError: u.error,
            attempts: (it.attempts ?? 0) + (retryable ? 0 : 1),
          }
          if (retryable) failed.retryableFailures = (it.retryableFailures ?? 0) + 1
          else delete failed.retryableFailures // not consecutive any more
          // Parked by attempt counting: the PIN has no further use.
          next.push((failed.attempts ?? 0) >= MAX_ATTEMPTS ? stripSecrets(failed) : failed)
        }
      }
      return changed ? next : null
    })
  }

  ack(idempotencyKey: string): Promise<void> {
    return this.settle([{ key: idempotencyKey, op: 'ack' }])
  }

  fail(idempotencyKey: string, error: string): Promise<void> {
    return this.settle([{ key: idempotencyKey, op: 'fail', error }])
  }

  /** Remove a single resolved item from the outbox (e.g. a handled terminal rejection). */
  discard(idempotencyKey: string): Promise<void> {
    return this.settle([{ key: idempotencyKey, op: 'discard' }])
  }

  /** Re-queue every parked (dead-lettered) item: reset status + attempts so
   *  the next flush retries them. Used by the manual "retry" action. Unlike the
   *  ack/fail bookkeeping this is user-initiated, so a failed write rejects. */
  retryDeadLettered(): Promise<void> {
    return this.run(async () => {
      let changed = false
      const next = this.items.map((i): OutboxItem => {
        if (i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS) {
          changed = true
          const requeued: OutboxItem = { ...i, status: 'pending', attempts: 0 }
          delete requeued.reviewCode
          delete requeued.reviewReason
          delete requeued.retryableFailures
          return requeued
        }
        return i
      })
      if (changed) await this.commit(next)
    })
  }

  /** Drop acked rows once their canonical order is reconciled locally. */
  prune(): Promise<void> {
    return this.mutate((items) => {
      const next = items.filter((i) => i.status !== 'acked')
      return next.length === items.length ? null : next
    })
  }

  /** Resolves when every mutation queued so far has settled (tests/diagnostics). */
  idle(): Promise<void> {
    return this.tail
  }

  all(): readonly OutboxItem[] {
    return this.items
  }
}
