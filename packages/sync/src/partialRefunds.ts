import { readJSON, type KV } from './storage'

/** Durable key: per-line refunds (C4b) this tablet has seen the server acknowledge. NEW and additive: it is
 *  not read by any older bundle, and `syncedRefunds.ts` (whole-order "done" markers, journal-guarded) keeps
 *  its own format untouched. Rollback to an older bundle simply ignores this key. */
export const PARTIAL_REFUNDS_KEY = 'mandalika.pos.partialRefunds'
/** Bound: newest entries only, and nothing older than the window (same as the synced-refund memory). */
export const PARTIAL_REFUNDS_MAX = 500
export const PARTIAL_REFUNDS_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** One refund line: `lineNo` is the position in the sale, `qty` the units returned. */
export interface PartialRefundLine { lineNo: number; qty: number }

/** One acknowledged per-line refund. `refundKey` (the outbox idempotency key) makes {@link PartialRefunds.addMany}
 *  idempotent: the ack path and the startup self-heal may both record the same refund. */
export interface PartialRefundEntry {
  refundKey: string
  /** Every id naming the order: the server id and/or the sale's client uuid. */
  orderIds: string[]
  lines: PartialRefundLine[]
  /** The amount the tablet paid out for this refund (display only; the server Order read wins when online). */
  amount: number
  /** What the ack said about the order after this refund: 'full' = nothing left to refund, 'partial' = some units remain.
   *  Absent = not known (an older server, or recorded by the startup self-heal). Frozen format: add values, never rename. */
  refundState?: 'full' | 'partial'
  at: number
}

const isLine = (l: unknown): l is PartialRefundLine =>
  !!l && typeof l === 'object' && Number.isInteger((l as PartialRefundLine).lineNo) && (l as PartialRefundLine).lineNo >= 0
  && Number.isInteger((l as PartialRefundLine).qty) && (l as PartialRefundLine).qty > 0

const isEntry = (e: unknown): e is PartialRefundEntry => {
  if (!e || typeof e !== 'object') return false
  const v = e as PartialRefundEntry
  return typeof v.refundKey === 'string' && v.refundKey !== ''
    && Array.isArray(v.orderIds) && v.orderIds.length > 0 && v.orderIds.every((id) => typeof id === 'string' && id !== '')
    && Array.isArray(v.lines) && v.lines.length > 0 && v.lines.every(isLine)
    && typeof v.amount === 'number' && Number.isFinite(v.amount) && typeof v.at === 'number'
    && (v.refundState === undefined || v.refundState === 'full' || v.refundState === 'partial')
}

/** Small persistent record of acknowledged per-line refunds. An acked refund leaves the outbox and a cached
 *  history row (or local receipt) still shows the sold quantities: this lets the refund dialog subtract what
 *  this tablet already returned while offline. A convenience cache, bounded and best effort: the server
 *  (`refundedQty` on the Order read, and the quantity guard under the order lock) stays the authority. */
export class PartialRefunds {
  /** Serializes {@link addMany}: each call reads the stored list only after the previous write landed. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private kv: KV) {}

  private read(): PartialRefundEntry[] {
    const raw = readJSON<unknown>(this.kv, PARTIAL_REFUNDS_KEY, [])
    return Array.isArray(raw) ? raw.filter(isEntry) : []
  }

  private live(entries: PartialRefundEntry[]): PartialRefundEntry[] {
    const cutoff = Date.now() - PARTIAL_REFUNDS_TTL_MS
    return entries.filter((e) => e.at >= cutoff).slice(-PARTIAL_REFUNDS_MAX)
  }

  /** Durably remember refunds. Resolves only once stored and REJECTS otherwise, so the caller can keep the
   *  acked refund row (the other copy of this fact). A refund already stored (same key) is left as it was. */
  addMany(incoming: readonly PartialRefundEntry[]): Promise<void> {
    const fresh = incoming.filter(isEntry)
    if (!fresh.length) return Promise.resolve()
    const run = this.chain.then(() => {
      const kept = this.read()
      const byKey = new Map(kept.map((e) => [e.refundKey, e]))
      // A key already stored is left as it was, except that learning what the ack said is never lost ('full' wins).
      const stateFor = (key: string): 'full' | 'partial' | undefined =>
        fresh.some((f) => f.refundKey === key && f.refundState === 'full') ? 'full' : fresh.find((f) => f.refundKey === key && f.refundState)?.refundState
      const upgraded = kept.map((e) => {
        const s = stateFor(e.refundKey)
        return s && (e.refundState === undefined || (s === 'full' && e.refundState !== 'full')) ? { ...e, refundState: s } : e
      })
      const added = fresh
        .filter((e, i) => !byKey.has(e.refundKey) && fresh.findIndex((x) => x.refundKey === e.refundKey) === i)
        .map((e) => { const s = stateFor(e.refundKey); return s && s !== e.refundState ? { ...e, refundState: s } : e })
      if (!added.length && upgraded.every((e, i) => e === kept[i])) return undefined
      return this.kv.setDurable(PARTIAL_REFUNDS_KEY, JSON.stringify(this.live([...upgraded, ...added])))
    })
    this.chain = run.catch(() => {})
    return run
  }

  /** Resolves when every addMany queued so far has settled. */
  idle(): Promise<unknown> {
    return this.chain
  }

  entries(): PartialRefundEntry[] {
    return this.live(this.read())
  }

  /** Every id of an order whose refunds the server reported as leaving it fully refunded. */
  fullOrderIds(): Set<string> {
    return new Set(this.entries().filter((e) => e.refundState === 'full').flatMap((e) => e.orderIds))
  }

  /** Units refunded per lineNo across every refund that names any of `orderIds`. */
  refundedQty(orderIds: readonly string[]): Map<number, number> {
    const ids = new Set(orderIds.filter(Boolean))
    const out = new Map<number, number>()
    if (!ids.size) return out
    for (const e of this.entries()) {
      if (!e.orderIds.some((id) => ids.has(id))) continue
      for (const l of e.lines) out.set(l.lineNo, (out.get(l.lineNo) ?? 0) + l.qty)
    }
    return out
  }

  /** Total paid out across the refunds that name any of `orderIds`. */
  refundedAmount(orderIds: readonly string[]): number {
    const ids = new Set(orderIds.filter(Boolean))
    if (!ids.size) return 0
    return this.entries().filter((e) => e.orderIds.some((id) => ids.has(id))).reduce((s, e) => s + e.amount, 0)
  }
}

/** The per-line refund a queued/acked refund payload describes, or null for a legacy whole-order payload
 *  (no `items`) or a malformed one. Pure; the payload is read, never changed (A11 fingerprint). */
export function partialRefundFromPayload(
  refundKey: string,
  payload: Readonly<Record<string, unknown>>,
  extraOrderIds: readonly string[] = [],
  at: number = Date.now(),
  refundState?: 'full' | 'partial',
): PartialRefundEntry | null {
  const items = payload.items
  if (!Array.isArray(items) || items.length === 0 || !refundKey) return null
  const lines: PartialRefundLine[] = []
  for (const it of items) {
    if (!isLine({ lineNo: (it as { lineNo?: unknown })?.lineNo, qty: (it as { quantity?: unknown })?.quantity })) return null
    lines.push({ lineNo: (it as { lineNo: number }).lineNo, qty: (it as { quantity: number }).quantity })
  }
  const orderIds = [...new Set([payload.orderId, payload.saleOrderUuid, ...extraOrderIds].filter((v): v is string => typeof v === 'string' && v !== ''))]
  if (!orderIds.length) return null
  const amount = typeof payload.refundAmount === 'number' && Number.isFinite(payload.refundAmount) ? payload.refundAmount : 0
  return { refundKey, orderIds, lines, amount, ...(refundState ? { refundState } : {}), at }
}
