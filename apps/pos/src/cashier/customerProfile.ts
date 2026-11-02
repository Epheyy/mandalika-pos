import type { components } from '@mandalika/api'
import type { LocalReceipt } from '@mandalika/sync'
import type { ReceiptSnapshotLine } from './receiptQuote'
import { SPLIT_LABEL } from '../lib/paymentLabels'
import { SPLIT_METHOD_ID } from './tenderSplit'

type Customer = components['schemas']['Customer']
type Product = components['schemas']['Product']
export type CustomerProfile = components['schemas']['CustomerProfile']
type ProfileLine = components['schemas']['CustomerProfileOrderLine']
type Pitch = components['schemas']['CustomerProfilePitch']

// Pure rules behind the customer chip, the Pelanggan sheet and the Profil Pelanggan sheet (B3, D-25).

const DAY_MS = 24 * 60 * 60 * 1000

export type Tier = 'Member' | 'Silver' | 'Gold' | 'Platinum'

/** Port of the backend `CustomerTier` (service/pricing.go): the tier a lifetime spend earns. */
export function tierForSpend(totalSpent: number): Tier {
  if (totalSpent >= 5_000_000) return 'Platinum'
  if (totalSpent >= 2_000_000) return 'Gold'
  if (totalSpent >= 500_000) return 'Silver'
  return 'Member'
}

/** The tier to show for a customer the tablet knows only from the lookup. The tablet memory
 *  stores no spend (0), so a customer with no known spend shows no tier instead of a wrong "Member". */
export function knownTier(c: Pick<Customer, 'totalSpent' | 'visitCount'>): Tier | null {
  return c.totalSpent > 0 || c.visitCount > 0 ? tierForSpend(c.totalSpent) : null
}

/** "3 hari lalu" / "2 minggu lalu" / "4 bulan lalu"; "hari ini" within a day. Null for an unreadable date. */
export function relativeDays(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(t)) return null
  const days = Math.max(0, Math.floor((now - t) / DAY_MS))
  if (days < 1) return 'hari ini'
  if (days < 14) return `${days} hari lalu`
  if (days < 60) return `${Math.floor(days / 7)} minggu lalu`
  return `${Math.floor(days / 30)} bulan lalu`
}

/** Whole days since the customer's last order on the profile, or null when there is none. */
export function daysSinceLast(profile: Pick<CustomerProfile, 'pitch'>, now: number): number | null {
  const t = profile.pitch.lastAt ? Date.parse(profile.pitch.lastAt) : Number.NaN
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null
}

/** The "Bahan obrolan" lines, built from the server's pitch facts. Empty when there is nothing to say. */
export function pitchLines(pitch: Pitch, now: number): string[] {
  const lines: string[] = []
  if (pitch.lastItem) {
    const when = relativeDays(pitch.lastAt, now)
    let s = `Terakhir beli ${pitch.lastItem}${when ? ` (${when})` : ''}.`
    const interval = pitch.usualIntervalDays
    if (interval && interval > 0) {
      const weeks = Math.floor(interval / 7)
      s += ` Biasanya habis dalam ±${weeks >= 1 ? `${weeks} minggu` : `${interval} hari`} — tawarkan ukuran lebih besar.`
    }
    lines.push(s)
  }
  if (pitch.neverTriedCategories.length > 0) lines.push(`${pitch.neverTriedCategories.join(', ')} belum pernah dicoba.`)
  return lines
}

export interface RepeatPlan {
  /** One add per product: the same shape `addWithStockWarning` takes. */
  adds: { product: Product; variantQtys: Record<string, number> }[]
  /** Names of lines that could not be repeated (product or size no longer sold). */
  skipped: string[]
}

/** The lines "Ulangi" adds again: paid lines only (a Rp0 reward is never repeated), merged per product, each
 *  against the CURRENT catalog so a retired size is skipped by name instead of failing the whole repeat. */
export function planRepeat(lines: readonly Pick<ProfileLine, 'productId' | 'name' | 'size' | 'qty' | 'free'>[], products: readonly Product[]): RepeatPlan {
  const byProduct = new Map<string, { product: Product; variantQtys: Record<string, number> }>()
  const skipped: string[] = []
  for (const l of lines) {
    if (l.free || l.qty <= 0) continue
    const product = products.find((p) => p.id === l.productId)
    if (!product || !product.variants.some((v) => v.size === l.size)) {
      if (!skipped.includes(l.name)) skipped.push(l.name)
      continue
    }
    const entry = byProduct.get(product.id) ?? { product, variantQtys: {} }
    entry.variantQtys = { ...entry.variantQtys, [l.size]: (entry.variantQtys[l.size] ?? 0) + l.qty }
    byProduct.set(product.id, entry)
  }
  return { adds: [...byProduct.values()], skipped }
}

/** The same plan for one "Sering dibeli" chip: one unit of that product and size. */
export function planOne(item: { productId: string; size: string; name: string }, products: readonly Product[]): RepeatPlan {
  return planRepeat([{ productId: item.productId, name: item.name, size: item.size, qty: 1, free: false }], products)
}

export interface LocalHistoryOrder {
  id: string
  number: string
  at: string
  paymentMethod: string
  total: number
  lines: ProfileLine[]
}

const isLine = (l: unknown): l is ReceiptSnapshotLine =>
  !!l && typeof l === 'object' && typeof (l as ReceiptSnapshotLine).productId === 'string' && typeof (l as ReceiptSnapshotLine).qty === 'number'

/** The receipts the engine linked to one customer (`localReceiptsForCustomer`), newest first: the offline /
 *  pre-deploy history. Reads the A10 snapshot only. */
export function localHistoryFor(receipts: readonly LocalReceipt[], limit = 5): LocalHistoryOrder[] {
  const out: LocalHistoryOrder[] = []
  for (const r of receipts) {
    if (r.refunded) continue
    const snap = r.receiptSnapshot as { lines?: unknown[]; total?: number } | null
    const lines = (Array.isArray(snap?.lines) ? snap.lines : []).filter(isLine).map((l) => ({
      productId: l.productId, name: l.name, size: l.variantSize, qty: l.qty, free: l.isReward === true || l.amount === 0,
    }))
    out.push({ id: r.orderUuid, number: r.orderNumber, at: r.capturedAt, paymentMethod: r.paymentMethod === SPLIT_METHOD_ID ? SPLIT_LABEL : r.paymentMethod, total: r.quotedTotal ?? snap?.total ?? 0, lines })
    if (out.length >= limit) break
  }
  return out
}

/** Customers served on this tablet, newest first, from the tablet memory order (it moves a customer to the front
 *  each time one is used). De-duplicated by id and without the ones already in `exclude`. */
export function recentCustomers(memory: readonly Customer[], exclude: readonly Customer[], limit = 5): Customer[] {
  const skip = new Set(exclude.map((c) => c.id))
  const out: Customer[] = []
  for (const c of memory) {
    if (skip.has(c.id)) continue
    skip.add(c.id)
    out.push(c)
    if (out.length >= limit) break
  }
  return out
}

export interface ChipState {
  /** What the second line says about rewards. */
  rewards: { kind: 'hidden' } | { kind: 'offline' } | { kind: 'loading' } | { kind: 'count'; n: number }
}

/** The reward part of the customer chip: hidden when loyalty is off, "Butuh internet" offline, a count online. */
export function chipRewards(input: { loyaltyEnabled: boolean; online: boolean; loading: boolean; count: number }): ChipState['rewards'] {
  if (!input.loyaltyEnabled) return { kind: 'hidden' }
  if (!input.online) return { kind: 'offline' }
  if (input.loading) return { kind: 'loading' }
  return { kind: 'count', n: input.count }
}

/** Reward menus (one per loyalty condition) the preview offers, minus the ones the cart already holds as a reward line. */
export function rewardsAvailableCount(
  rewards: readonly components['schemas']['LoyaltyPreviewReward'][],
  cart: readonly { isReward?: boolean; rewardConditionId?: string | null }[],
): number {
  const taken = new Set(cart.filter((c) => c.isReward && c.rewardConditionId).map((c) => c.rewardConditionId))
  return rewards.filter((r) => !taken.has(r.conditionId)).length
}

/** The reward words under the name; null when there is nothing to say. */
export function rewardChipText(r: ChipState['rewards']): string | null {
  switch (r.kind) {
    case 'hidden': return null
    case 'offline': return 'Hadiah: Butuh internet'
    case 'loading': return 'Memeriksa hadiah…'
    case 'count': return r.n > 0 ? `${r.n} hadiah tersedia · pilih di Bayar` : 'Belum ada hadiah'
  }
}
