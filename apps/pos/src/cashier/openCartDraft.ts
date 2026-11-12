import { getKV, readJSON, type KV } from '@mandalika/sync'
import type { components } from '@mandalika/api'
import { heldOrderFromState, type HeldOrder, type HeldSource } from './heldOrders'

type Product = components['schemas']['Product']

// P-20 "Keranjang terbuka": the sale being rung up survives a WebView reload or an app restart on THIS tablet.
// Same storage family as held orders and the split draft (app KV, never the outbox, never a payload), same HeldOrder
// shape so the restore reuses planHeldRestore (live catalogue re-pricing, promo/code re-guard).
//
// The safety property: a draft must never become a second sale or reappear after it was paid. Three layers:
//  1. `saleUuid` is minted with the cart and used as the sale's order uuid, so the draft and the queued sale share one
//     idempotency key; hydration drops a draft whose uuid is already in the outbox or the receipt archive.
//  2. The draft is deleted right after the enqueue resolves (inside the sale gate).
//  3. Nothing is written while the success view is open (ORDER_SUCCESS keeps the cart in state until it is closed).

export const OPEN_CART_VERSION = 1
/** A cart left a full day is a stale sale (prices, promos, stock): forgotten, like the split draft. */
export const OPEN_CART_TTL_MS = 24 * 60 * 60 * 1000

export interface OpenCartDraft {
  v: typeof OPEN_CART_VERSION
  /** The sale's order uuid: the enqueue reuses it, so a draft can never turn into a second sale. */
  saleUuid: string
  /** The cashier who built it: another account never inherits a cart on a shared tablet. */
  userId: string
  savedAt: number
  /** The cart and its adjustments, in the held-order shape. */
  held: HeldOrder
}

export const openCartKey = (outletId: string): string => `mandalika.pos.openCart.${outletId || 'unbound'}`

const isDraft = (v: unknown): v is OpenCartDraft => {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<OpenCartDraft>
  const h = d.held as Partial<HeldOrder> | undefined
  return d.v === OPEN_CART_VERSION && typeof d.saleUuid === 'string' && d.saleUuid !== '' && typeof d.userId === 'string' &&
    typeof d.savedAt === 'number' && !!h && h.v === 1 && Array.isArray(h.lines) && h.lines.length > 0 &&
    Array.isArray(h.promotions) && Array.isArray(h.codes) && !!h.discount && !!h.surcharge &&
    typeof h.rewardPicks === 'object' && h.rewardPicks !== null
}

export type OpenCartSource = HeldSource & { isSuccessOpen: boolean; splitMode: boolean; tenders: readonly unknown[] }

/**
 * The draft to keep for this state, or null when none should exist: an empty cart (Kosongkan, hold, new sale,
 * rewards only) or the success view of a sale that is already queued. Pure.
 */
export function openCartFromState(state: OpenCartSource, o: { saleUuid: string; userId: string; now: number }): OpenCartDraft | null {
  if (state.isSuccessOpen || state.cart.length === 0 || !o.userId) return null
  // With payment lines entered the split draft is the only owner of this sale: a plain restored cart would hide a charge already taken.
  if (state.splitMode && state.tenders.length > 0) return null
  const held = heldOrderFromState(state, { id: o.saleUuid, name: 'Keranjang terbuka', now: o.now })
  if (held.lines.length === 0) return null
  return { v: OPEN_CART_VERSION, saleUuid: o.saleUuid, userId: o.userId, savedAt: o.now, held }
}

export type HydrateDecision = 'restore' | 'drop'

/** What to do with a stored draft at start. 'drop' deletes it: wrong cashier, already a sale, or the split draft of the same sale owns the cart. Pure. */
export function decideHydration(
  draft: OpenCartDraft | null,
  o: { userId: string | null; saleUuids: ReadonlySet<string>; splitDraftOrderUuid: string | null },
): HydrateDecision {
  if (!draft || !o.userId || draft.userId !== o.userId) return 'drop'
  if (o.saleUuids.has(draft.saleUuid)) return 'drop'
  // Only the split draft OF THIS sale owns it; a different sale rung up beside a waiting split draft still restores.
  if (o.splitDraftOrderUuid === draft.saleUuid) return 'drop'
  return 'restore'
}

/** Lines of the draft the live catalogue no longer sells, and lines whose price changed. */
export function revalidationDelta(held: HeldOrder, products: readonly Product[]): { unavailable: number; repriced: number } {
  let unavailable = 0
  let repriced = 0
  for (const line of held.lines) {
    const variant = products.find((p) => p.id === line.productId)?.variants.find((v) => v.size === line.variantSize)
    if (!variant) unavailable += 1
    else if (variant.price !== (line.bundleGroup != null ? line.bundleBasisPrice : line.price)) repriced += 1
  }
  return { unavailable, repriced }
}

/** "Keranjang dipulihkan · 1 item tidak tersedia lagi · 2 harga diperbarui", or null when nothing changed. */
export function restoreToast(delta: { unavailable: number; repriced: number }, notes: readonly string[]): string | null {
  const parts: string[] = []
  if (delta.unavailable > 0) parts.push(`${delta.unavailable} item tidak tersedia lagi`)
  if (delta.repriced > 0) parts.push(`${delta.repriced} harga diperbarui`)
  if (parts.length === 0 && notes.length === 0) return null
  const head = ['Keranjang dipulihkan', ...parts].join(' · ')
  return notes.length > 0 ? `${head}\n${notes.join('\n')}` : head
}

/** The one open-cart draft of this tablet and outlet. Malformed, other-version or expired content reads as no draft. */
export class OpenCartStore {
  constructor(
    private kv: KV,
    private key: string,
    private now: () => number = Date.now,
  ) {}

  read(): OpenCartDraft | null {
    const raw = readJSON<unknown>(this.kv, this.key, null)
    if (!isDraft(raw)) return null
    return this.now() - raw.savedAt > OPEN_CART_TTL_MS ? null : raw
  }

  /** Durable write: resolves once stored, rejects when it could not be. */
  save(draft: OpenCartDraft): Promise<void> {
    return this.kv.setDurable(this.key, JSON.stringify(draft))
  }

  clear(): Promise<void> {
    return this.kv.removeDurable(this.key)
  }
}

const stores = new Map<string, OpenCartStore>()
export function getOpenCartStore(outletId: string): OpenCartStore {
  const key = openCartKey(outletId)
  let s = stores.get(key)
  if (!s) {
    s = new OpenCartStore(getKV(), key)
    stores.set(key, s)
  }
  return s
}
