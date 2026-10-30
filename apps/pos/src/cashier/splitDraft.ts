import { getKV, readJSON, type KV } from '@mandalika/sync'
import { heldOrderFromState, type HeldOrder, type HeldSource } from './heldOrders'
import { formatRupiah } from './pricing'
import type { TenderLine } from './tenderSplit'

// C6 D-62 "Pembayaran terpisah belum selesai". With split payment the first non-cash line is charged on the EDC or in
// an e-wallet app BEFORE the sale exists, and Android may kill the POS while the cashier is in that app. The draft
// keeps the cart and the entered lines on this tablet (app KV through the held-orders machinery, never the journal)
// and, above all, the sale's order uuid: Konfirmasi enqueues with that uuid, so the idempotency key is fixed from the
// first charge and a draft can never become a second sale.

export const SPLIT_DRAFT_NAME = 'Pembayaran terpisah belum selesai'
export const SPLIT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export interface SplitDraft {
  v: 1
  /** The sale's order uuid, minted when split mode started. */
  orderUuid: string
  savedAt: number
  /** The cart and its adjustments, in the held-order shape so restore reuses the B4 planner. */
  held: HeldOrder
  tenders: TenderLine[]
  /** The order total when the draft was saved, for the banner only. */
  total: number
}

export const splitDraftKey = (outletId: string): string => `mandalika.pos.splitDraft.${outletId || 'unbound'}`

const isTenderLine = (v: unknown): v is TenderLine => {
  if (!v || typeof v !== 'object') return false
  const t = v as Partial<TenderLine>
  return typeof t.method === 'string' && t.method !== '' && typeof t.amount === 'number' && Number.isFinite(t.amount) && t.amount >= 0 &&
    (t.reference === undefined || typeof t.reference === 'string')
}

const isDraft = (v: unknown): v is SplitDraft => {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<SplitDraft>
  return d.v === 1 && typeof d.orderUuid === 'string' && d.orderUuid !== '' && typeof d.savedAt === 'number' && typeof d.total === 'number' &&
    !!d.held && Array.isArray(d.held.lines) && Array.isArray(d.tenders) && d.tenders.length > 0 && d.tenders.every(isTenderLine)
}

export type SplitDraftSource = HeldSource & { splitMode: boolean; tenders: readonly TenderLine[]; splitOrderUuid: string | null }

/** The draft to keep for this state, or null when there is nothing worth keeping: a draft exists only once a NON-CASH line is entered. */
export function splitDraftFromState(state: SplitDraftSource, total: number, isCash: (method: string) => boolean, now: number): SplitDraft | null {
  if (!state.splitMode || !state.splitOrderUuid || !state.tenders.some((l) => !isCash(l.method))) return null
  return {
    v: 1,
    orderUuid: state.splitOrderUuid,
    savedAt: now,
    held: heldOrderFromState(state, { id: state.splitOrderUuid, name: SPLIT_DRAFT_NAME, now }),
    tenders: state.tenders.map((l) => ({ ...l })),
    total,
  }
}

/** "QRIS Rp 751.000 + Kartu Rp 100.000" of the lines already charged (non-cash only: cash was not taken yet). */
export function draftChargedSummary(draft: SplitDraft, isCash: (method: string) => boolean, labelOf: (method: string) => string): string {
  return draft.tenders.filter((l) => !isCash(l.method)).map((l) => `${labelOf(l.method)} ${formatRupiah(l.amount)}`).join(' + ')
}

/** The one draft of this tablet and outlet. Malformed or expired content reads as no draft. */
export class SplitDraftStore {
  constructor(
    private kv: KV,
    private key: string,
    private now: () => number = Date.now,
  ) {}

  read(): SplitDraft | null {
    const raw = readJSON<unknown>(this.kv, this.key, null)
    if (!isDraft(raw)) return null
    return this.now() - raw.savedAt > SPLIT_DRAFT_TTL_MS ? null : raw
  }

  /** Durable write: resolves once stored, rejects when it could not be. */
  save(draft: SplitDraft): Promise<void> {
    return this.kv.setDurable(this.key, JSON.stringify(draft))
  }

  clear(): Promise<void> {
    return this.kv.removeDurable(this.key)
  }
}

const stores = new Map<string, SplitDraftStore>()
/** The draft store for this outlet, on the same app KV the held orders use. */
export function getSplitDraftStore(outletId: string): SplitDraftStore {
  const key = splitDraftKey(outletId)
  let s = stores.get(key)
  if (!s) {
    s = new SplitDraftStore(getKV(), key)
    stores.set(key, s)
  }
  return s
}

/**
 * Whether a stored draft is already a sale: its uuid is in the outbox or the receipt archive. Dropped silently on
 * start, because the sale was queued and only the draft delete was lost (plan 2.7 step 3).
 */
export function draftIsAlreadyASale(draft: SplitDraft, saleUuids: ReadonlySet<string>): boolean {
  return saleUuids.has(draft.orderUuid)
}
