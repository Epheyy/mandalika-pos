import type { KV } from './storage'
import type { OutboxItem } from './outbox'

/** Durable key: receipts of sales made on this tablet that the server has acknowledged (A41). */
export const RECEIPT_ARCHIVE_KEY = 'mandalika.pos.receiptArchive'
/** A local receipt is kept while younger than this OR among the newest {@link RECEIPT_KEEP_NEWEST}. */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const RECEIPT_KEEP_NEWEST = 500

/** One archived receipt (v1). Customer, notes and salesman data are deliberately NOT copied (A30).
 *  Identity is `orderUuid` only: order numbers repeat. */
export interface ReceiptEntry {
  orderUuid: string
  idempotencyKey: string
  /** Known once the ack carried the server id; refunds of this sale may then send it. */
  serverOrderId?: string
  orderNumber: string
  capturedAt: string
  outletId: string
  shiftId: string | null
  paymentMethod: string
  quotedTotal: number | null
  /** The A10 receipt snapshot, verbatim. */
  receiptSnapshot: unknown
  archivedAt: number
  /** C4b: per sale line (payload order), what the line is worth after discounts: the TS allocator's share, used
   *  ONLY for a refund of a sale that has not synced. Optional and additive (no snapshot version bump); absent
   *  on sales archived before C4b, which then refund whole-order only. */
  lineNets?: number[]
  /** C4b: per sale line, the promo group key ("bundle:<id>:1" / "bxgy:<id>:1") or null. Same rules as lineNets. */
  lineGroups?: (string | null)[]
  /** C6: the payment lines of the sale (amount = captured). Optional and additive; absent on single-method
   *  sales archived before C6 and when the payload's tenders were malformed. */
  tenders?: ArchivedTender[]
}

export interface ArchivedTender {
  method: string
  amount: number
  reference?: string
}

const MAX_TENDERS = 4

/** An unacknowledged sale still in the outbox: counts toward the newest-500 floor. */
export interface UnsyncedSale {
  orderUuid: string
  outletId: string
  capturedAt: string
  seq: number
}

export interface ReceiptContext {
  unsynced: readonly UnsyncedSale[]
  /** Sale uuids and server order ids named by refunds that are not yet acknowledged. */
  referenced: ReadonlySet<string>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The per-line facts the sale payload carries (`items[i].netAmount` / `refundGroup`). Both or nothing: a sale
 *  where any line lacks a whole-rupiah net keeps no line data and refunds whole-order only. */
export function lineDataFromItems(items: unknown): { lineNets: number[]; lineGroups: (string | null)[] } | null {
  if (!Array.isArray(items) || items.length === 0) return null
  const lineNets: number[] = []
  const lineGroups: (string | null)[] = []
  for (const it of items) {
    const net = (it as { netAmount?: unknown } | null)?.netAmount
    if (typeof net !== 'number' || !Number.isSafeInteger(net) || net < 0) return null
    lineNets.push(net)
    lineGroups.push(str((it as { refundGroup?: unknown }).refundGroup))
  }
  return { lineNets, lineGroups }
}

/** The sale payload's `tenders`, or undefined when absent or anything in it is malformed (all or nothing). */
export function tendersFromPayload(v: unknown): ArchivedTender[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TENDERS) return undefined
  const out: ArchivedTender[] = []
  for (const raw of v) {
    const t = raw as { method?: unknown; amount?: unknown; reference?: unknown } | null
    if (!t || typeof t !== 'object') return undefined
    const method = str(t.method)
    if (!method || typeof t.amount !== 'number' || !Number.isFinite(t.amount) || t.amount < 0) return undefined
    if (t.reference !== undefined && t.reference !== null && typeof t.reference !== 'string') return undefined
    out.push({ method, amount: t.amount, ...(typeof t.reference === 'string' && t.reference !== '' ? { reference: t.reference } : {}) })
  }
  return out
}

/** The receipt facts of an acked order item, or null when it is not a usable sale. */
export function receiptEntryFromItem(item: OutboxItem): ReceiptEntry | null {
  if (item.type !== 'order') return null
  const p = item.payload
  const orderUuid = str(p.orderUuid)
  const orderNumber = str(p.orderNumber)
  if (!orderUuid || !orderNumber) return null
  const entry: ReceiptEntry = {
    orderUuid,
    idempotencyKey: item.idempotencyKey,
    orderNumber,
    capturedAt: str(item.envelope?.capturedAt) ?? item.clientCreatedAt,
    outletId: str(item.envelope?.outletId) ?? '',
    shiftId: str(item.envelope?.shiftId),
    paymentMethod: str(p.paymentMethod) ?? '',
    quotedTotal: typeof p.quotedTotal === 'number' ? p.quotedTotal : null,
    receiptSnapshot: p.receiptSnapshot ?? null,
    archivedAt: Date.now(),
  }
  const lines = lineDataFromItems(p.items)
  if (lines) Object.assign(entry, lines)
  const tenders = tendersFromPayload(p.tenders)
  if (tenders) entry.tenders = tenders
  const serverId = str((item as OutboxItem & { ackedOrderId?: unknown }).ackedOrderId)
  if (serverId) entry.serverOrderId = serverId
  return entry
}

interface Ranked { id: string; at: number; unsynced: boolean; index: number }

/** The orderUuids to drop: older than 7 days AND beyond the newest 500 of their outlet (unsynced sales
 *  and archived receipts counted together) AND not referenced by an unacknowledged refund. A capture
 *  time that cannot be read is never pruned. Pure. */
export function prunable(entries: readonly ReceiptEntry[], ctx: ReceiptContext, now: number): Set<string> {
  const byOutlet = new Map<string, Ranked[]>()
  const push = (outletId: string, r: Ranked) => {
    const list = byOutlet.get(outletId)
    if (list) list.push(r)
    else byOutlet.set(outletId, [r])
  }
  const time = (iso: string) => {
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t : Number.NaN
  }
  entries.forEach((e, index) => push(e.outletId, { id: e.orderUuid, at: time(e.capturedAt), unsynced: false, index }))
  ctx.unsynced.forEach((u) => push(u.outletId, { id: u.orderUuid, at: time(u.capturedAt), unsynced: true, index: u.seq }))
  const rankOf = new Map<string, number>()
  for (const list of byOutlet.values()) {
    // Newest first; on a tie unsynced sales come first, then the later-archived receipt.
    const key = (r: Ranked) => (Number.isNaN(r.at) ? -Infinity : r.at)
    list.sort((a, b) => key(b) - key(a) || Number(b.unsynced) - Number(a.unsynced) || b.index - a.index)
    list.forEach((r, i) => { if (!r.unsynced) rankOf.set(r.id, i + 1) })
  }
  const dropped = new Set<string>()
  for (const e of entries) {
    const at = time(e.capturedAt)
    if (Number.isNaN(at)) continue
    if (now - at <= RECEIPT_RETENTION_MS) continue
    if ((rankOf.get(e.orderUuid) ?? 0) <= RECEIPT_KEEP_NEWEST) continue
    if (ctx.referenced.has(e.orderUuid) || (e.serverOrderId && ctx.referenced.has(e.serverOrderId))) continue
    dropped.add(e.orderUuid)
  }
  return dropped
}

/** Persistent record of acknowledged sales made on this tablet. The acked outbox row is pruned after the
 *  ack, so this is the only durable copy of the receipt: {@link addMany} resolves only once the new
 *  value is stored and REJECTS otherwise (the caller keeps the acked row until it is safe to drop). */
export class ReceiptArchive {
  /** Serializes {@link addMany}: each call reads the stored list only after the previous write landed. */
  private chain: Promise<unknown> = Promise.resolve()
  /** The parsed list for the raw stored value it was parsed from: a read does not re-parse an unchanged value
   *  (the archive can hold ~500 receipts and the POS asks for it on every render of the receipt surfaces). */
  private cacheRaw: string | null = null
  private cacheList: readonly ReceiptEntry[] = []

  constructor(private kv: KV) {}

  /** Read only: the returned list is shared with the cache. */
  entries(): readonly ReceiptEntry[] {
    const raw = this.kv.get(RECEIPT_ARCHIVE_KEY)
    if (raw === this.cacheRaw) return this.cacheList
    const list = parseEntries(raw)
    this.cacheRaw = raw
    this.cacheList = list
    return list
  }

  /** Merge `incoming` (dedupe by orderUuid), prune, and write only if the result differs from what is stored.
   *  An entry already archived keeps its archivedAt and a known server id, so folding the same acked row again
   *  is not a change. `context` is read inside the serialized chain so the prune sees the live outbox. */
  addMany(incoming: readonly ReceiptEntry[], context: () => ReceiptContext, now: number = Date.now()): Promise<void> {
    const run = this.chain.then(() => {
      const raw = this.kv.get(RECEIPT_ARCHIVE_KEY)
      const before = this.entries()
      const byUuid = new Map(before.map((e) => [e.orderUuid, e]))
      for (const e of incoming) {
        const prev = byUuid.get(e.orderUuid)
        if (!prev) {
          byUuid.set(e.orderUuid, e)
          continue
        }
        const serverOrderId = e.serverOrderId ?? prev.serverOrderId
        // Same position in the map (the entry was already there), same archivedAt: only real news changes the value.
        byUuid.set(e.orderUuid, { ...e, archivedAt: prev.archivedAt, ...(serverOrderId ? { serverOrderId } : {}) })
      }
      const merged = [...byUuid.values()]
      const drop = prunable(merged, context(), now)
      const next = drop.size ? merged.filter((e) => !drop.has(e.orderUuid)) : merged
      const json = JSON.stringify(next)
      if (json === (raw ?? '[]')) return undefined
      return this.kv.setDurable(RECEIPT_ARCHIVE_KEY, json).then(() => {
        this.cacheRaw = json
        this.cacheList = next
        // Q3: there is no hard cap, so the size is logged for the owner to watch (about 1-2 kB a receipt).
        console.info(`[sync] receipt archive: ${next.length} receipts, ${json.length} bytes`)
      })
    })
    this.chain = run.catch(() => {})
    return run
  }

  /** Resolves when every addMany queued so far has settled. */
  idle(): Promise<unknown> {
    return this.chain
  }
}

function parseEntries(raw: string | null): ReceiptEntry[] {
  if (!raw) return []
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list.filter(
    (e): e is ReceiptEntry =>
      !!e && typeof e.orderUuid === 'string' && e.orderUuid !== '' && typeof e.orderNumber === 'string' && typeof e.capturedAt === 'string',
  )
}
