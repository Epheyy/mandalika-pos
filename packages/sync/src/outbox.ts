import type { components } from '@mandalika/api'
import type { KV } from './storage'
import { isOutboxStore, KVOutboxStore, type OutboxStore } from './outboxStore'
import { parseSentinel } from './journalSentinel'

/** Capture-time identity stamped on an item when it is committed (A04). Persisted with
 *  the item and sent as a sibling of `payload`; never derived later, never backfilled. */
export type OutboxEnvelope = components['schemas']['SyncEnvelope']

/** Storage key of the durable queue; the POS login guard reads it before an engine exists. */
export const OUTBOX_KEY = 'mandalika.pos.outbox'
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
  /** Who/where/when the operation was captured. Absent on items written by bundles
   *  older than A04 (the server treats those as legacy). */
  envelope?: OutboxEnvelope
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
  /** Server id of an acked order/refund (A41). Top-level and additive: the payload, which the server
   *  fingerprints (A11), is never touched; older bundles ignore it. */
  ackedOrderId?: string
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
  | { key: string; op: 'ack'; orderId?: string }
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
  /** The account that captured the item (its envelope's userId), when it has one. */
  ownerUserId?: string
  /** Outlet recorded in the item's envelope at capture time, when it has one. */
  capturedOutletId?: string
  /** What was captured, read-only (e.g. the refund display snapshot for the review row).
   *  Never written back: the payload is what the server fingerprints. */
  readonly payload: Readonly<Record<string, unknown>>
}

/** What the durable queue holds, by what it means for handing the terminal to someone else. */
export interface QueueSummary {
  /** Queued or still retrying: the owning account must flush them. */
  pending: number
  /** Parked for review WITH a capture-time envelope: they stay in the outbox, never sent
   *  by another account (the server refuses a foreign envelope) and never deleted. */
  parkedStamped: number
  /** Parked without an envelope (written before A04): ownership is unknowable. */
  parkedUnstamped: number
  /** Distinct envelope userIds across all unacknowledged items. */
  owners: string[]
}

export interface QueueItemLike {
  status?: unknown
  attempts?: unknown
  envelope?: unknown
}

/** Pure so the engine and the login guard (which reads raw KV before any engine exists)
 *  classify the queue identically. */
export function summarizeQueue(items: readonly QueueItemLike[]): QueueSummary {
  const s: QueueSummary = { pending: 0, parkedStamped: 0, parkedUnstamped: 0, owners: [] }
  const owners = new Set<string>()
  for (const i of items) {
    if (!i || typeof i !== 'object' || i.status === 'acked') {
      if (!i || typeof i !== 'object') s.pending += 1 // junk entries count as not-empty
      continue
    }
    const env = i.envelope as { userId?: unknown } | undefined
    const owner = env && typeof env === 'object' && typeof env.userId === 'string' && env.userId ? env.userId : null
    if (owner) owners.add(owner)
    const parked = i.status === 'failed' && (typeof i.attempts === 'number' ? i.attempts : 0) >= MAX_ATTEMPTS
    if (!parked) s.pending += 1
    else if (owner) s.parkedStamped += 1
    else s.parkedUnstamped += 1
  }
  s.owners = [...owners]
  return s
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
      // An older bundle that met our journal sentinel quarantined it and left this marker; those
      // "corrupt" bytes are the pointer to the journal, not damage, so the marker means nothing.
      if (parseSentinel(kv.get(m.quarantineKey))) return null
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

  private store: OutboxStore

  /** A bare KV keeps today's behaviour (whole array under {@link OUTBOX_KEY}); pass an
   *  {@link OutboxStore} to persist elsewhere (the SQLite journal). */
  constructor(source: KV | OutboxStore) {
    const store: OutboxStore = isOutboxStore(source) ? source : new KVOutboxStore(source)
    this.store = store
    const kv = store.noticeKV ?? store.kv
    const loaded = store.load()
    let items: OutboxItem[] = []
    if (loaded.kind === 'ok') {
      items = loaded.items
    } else {
      const raw = loaded.raw
      const detectedAt = new Date().toISOString()
      const quarantineKey = OUTBOX_QUARANTINE_PREFIX + detectedAt
      this.corruption = { quarantineKey, detectedAt }
      const info = this.corruption
      this.ready = kv
        .setDurable(quarantineKey, raw)
        .then(() => kv.setDurable(OUTBOX_CORRUPTION_MARKER_KEY, JSON.stringify(info)))
      this.ready.catch(() => {}) // surfaced by commit(); avoid an unhandled rejection
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

  private async writable(): Promise<void> {
    if (this.disposed) throw new Error('outbox disposed')
    await this.ready
    if (this.disposed) throw new Error('outbox disposed')
  }

  /** Starts the store write synchronously (so a journal store can reserve the seq at once). If the
   *  store rejects and it can reload (journal), the live view is resynced from it before rethrowing:
   *  a stale view would otherwise fail every later compare-and-swap. No retry here. */
  private async write(next: OutboxItem[]): Promise<void> {
    try {
      await this.store.commit(this.items, next)
    } catch (err) {
      this.resync()
      throw err
    }
    this.items = next
  }

  private resync(): void {
    const fresh = this.store.reload?.()
    if (!fresh) return
    this.items = fresh
    this.seqCounter = fresh.reduce((m, i) => Math.max(m, i.seq), this.seqCounter)
  }

  /** Write `next` durably, then (only on success) make it the live queue. */
  private async commit(next: OutboxItem[]): Promise<void> {
    await this.writable()
    await this.write(next)
  }

  /** Re-read the committed queue from the store (journal only; no-op on KV). Call only after the
   *  previous instance and the store are idle, e.g. when an engine is replaced. */
  refresh(): Promise<void> {
    return this.run(async () => {
      if (!this.disposed) this.resync()
    })
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
  add(
    type: OutboxType,
    idempotencyKey: string,
    payload: Record<string, unknown>,
    envelope?: OutboxEnvelope,
  ): Promise<OutboxItem> {
    return this.run(async () => {
      const existing = this.items.find((i) => i.idempotencyKey === idempotencyKey)
      if (existing) return existing // never enqueue the same key twice
      await this.writable() // before the seq is picked, so no await sits between picking and writing
      const item: OutboxItem = {
        idempotencyKey,
        type,
        payload,
        seq: Math.max(this.seqCounter, this.store.maxSeq?.() ?? 0) + 1,
        status: 'pending',
        clientCreatedAt: new Date().toISOString(),
      }
      if (envelope) item.envelope = envelope
      await this.write([...this.items, item])
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
      ownerUserId: i.envelope?.userId,
      ...(i.envelope ? { capturedOutletId: i.envelope.outletId } : {}),
      payload: i.payload,
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
          next.push(u.orderId ? { ...it, status: 'acked', ackedOrderId: u.orderId } : { ...it, status: 'acked' })
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
  retryDeadLettered(include: (i: OutboxItem) => boolean = () => true): Promise<void> {
    return this.run(async () => {
      let changed = false
      const next = this.items.map((i): OutboxItem => {
        if (i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS && include(i)) {
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

  /** Remove items head office resolved. Only items STILL parked are removed — an item the
   *  cashier re-queued ("Coba lagi") in the meantime, or anything pending/unknown, is left
   *  alone. Checked against the live queue inside the serialized run, never a snapshot.
   *  Like retryDeadLettered, a failed durable write rejects and the queue is unchanged. */
  resolveReviewed(keys: readonly string[]): Promise<OutboxItem[]> {
    return this.run(async () => {
      const wanted = new Set(keys)
      const removed: OutboxItem[] = []
      const next = this.items.filter((i) => {
        const hit = wanted.has(i.idempotencyKey) && i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS
        if (hit) removed.push(i)
        return !hit
      })
      if (removed.length) await this.commit(next)
      return removed
    })
  }

  /** Drop acked rows once their canonical order is reconciled locally. `keep` retains the acked rows it
   *  returns true for (the engine keeps unarchived acked sales while the receipt archive cannot be written). */
  prune(keep?: (item: OutboxItem) => boolean): Promise<void> {
    return this.mutate((items) => {
      const next = items.filter((i) => i.status !== 'acked' || (keep?.(i) ?? false))
      return next.length === items.length ? null : next
    })
  }

  /** A08: remove a raw approver PIN from EVERY queued transfer_receive row, in any status (acked
   *  rows not yet pruned included). Older code queued the PIN in the payload; the new flow never
   *  does. Nothing else changes (seq, status, attempts, key). One write, none when already clean.
   *  Best-effort like {@link mutate}: a failed write is logged, the queue is left as it was, and the
   *  scrub runs again the next time the app starts (the engine runs it once per start). */
  scrubLegacySecrets(): Promise<void> {
    return this.mutate((items) => {
      let changed = false
      const next = items.map((i) => {
        const clean = stripSecrets(i)
        if (clean !== i) changed = true
        return clean
      })
      return changed ? next : null
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
