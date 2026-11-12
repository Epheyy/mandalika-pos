/**
 * Bundles (Phase 3): pure POS helpers. A bundle is three ordinary cart lines (large bottle,
 * 10ml atomizer, 2ml vial), qty 1 each, tied by a per-cart `bundleGroup` number. The Go server derives
 * the catalog; this file never derives anything, it only reads `bundleCatalog` from the sync pull.
 * `splitBundleAmount` / `minNet` are the twins of Go `bundles.Split` / `bundles.MinNet`
 * (shared golden: backend/internal/bundles/testdata/split_golden.json).
 */
import type { components } from '@mandalika/api'
import type { CashierState } from './state/cashierReducer'
import { stockFor } from './stock'

type CartItem = components['schemas']['CartItem']
type Product = components['schemas']['Product']
export type BundleCatalog = components['schemas']['BundleCatalog']
export type BundleOffer = components['schemas']['BundleOffer']
export type BundleRole = 'large' | 'atomizer' | 'vial'
export type Basis = [number, number, number]

/** Same bound as Go `bundles.MaxBundleMoney`. */
export const MAX_BUNDLE_MONEY = 1_000_000_000

function checkMoney(v: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(v) || v > MAX_BUNDLE_MONEY || v < (allowZero ? 0 : 1)) {
    throw new RangeError('bundle split amount or basis out of range')
  }
}

/** Go `Split` twin: floor shares for atomizer and vial, the remainder lands on the large bottle.
 *  BigInt keeps `amount * basis` exact (it reaches 3e18, past 2^53). */
export function splitBundleAmount(amount: number, basis: Basis): [number, number, number] {
  checkMoney(amount, true)
  basis.forEach((b) => checkMoney(b, false))
  const s = BigInt(basis[0]) + BigInt(basis[1]) + BigInt(basis[2])
  const a = Number((BigInt(amount) * BigInt(basis[1])) / s)
  const v = Number((BigInt(amount) * BigInt(basis[2])) / s)
  return [amount - a - v, a, v]
}

/** Go `MinNet` twin: the smallest net at which no piece share is below Rp1. */
export function minNet(basis: Basis): number {
  const s = basis[0] + basis[1] + basis[2]
  return Math.max(Math.ceil(s / basis[1]), Math.ceil(s / basis[2]))
}

export function isSetBundlePiece(c: CartItem): boolean {
  return c.bundleGroup != null
}

/** Mirrors Go `bundles.LineInfo`: only `bundleLine` is stored on a cart line. */
export function lineShort(line: string): string {
  if (line === 'EXTRAIT DE PARFUM') return 'EXT'
  if (line === 'PARFUM INTENSE') return 'PI'
  return line
}

/** `Bundle EXT 120ml`, or `Bundle 120ml` when the bundle has no line. */
export function bundleLabel(line: string, size: string): string {
  const short = lineShort(line)
  return short ? `Bundle ${short} ${size}` : `Bundle ${size}`
}

export function cardOffers(catalog: BundleCatalog | undefined, productId: string): BundleOffer[] {
  return catalog?.products.find((p) => p.productId === productId)?.offers ?? []
}

export function offerButtonMode(offers: BundleOffer[]): 'none' | 'buttons' | 'list' {
  if (offers.length === 0) return 'none'
  return offers.length <= 2 ? 'buttons' : 'list'
}

/** Units of one variant already in the cart (singles, pieces and reward lines all leave stock). */
export function inCartQty(cart: CartItem[], productId: string, variantSize: string): number {
  return cart.reduce((n, c) => (c.productId === productId && c.variantSize === variantSize ? n + c.quantity : n), 0)
}

/** Stock left for a variant after the cart; null when the variant is unknown to the catalog. */
export function stockLeft(products: Product[], cart: CartItem[], productId: string, size: string): number | null {
  const st = stockFor(products, productId, size)
  return st === null ? null : st - inCartQty(cart, productId, size)
}

/** O1: a bundle whose large bottle is at or below zero (counting the cart) shows "Habis" and is not tappable. */
export function offerSoldOut(offer: BundleOffer, productId: string, products: Product[], cart: CartItem[]): boolean {
  const left = stockLeft(products, cart, productId, offer.largeVariantSize)
  return left !== null && left <= 0
}

export function nextBundleGroup(cart: CartItem[]): number {
  return cart.reduce((m, c) => Math.max(m, c.bundleGroup ?? 0), 0) + 1
}

function variantOf(product: Product | undefined, size: string) {
  return product?.variants.find((v) => v.size === size)
}

/** The three lines of one bundle, in order large, atomizer, vial, priced at their share of `offer.price`.
 *  Returns no lines when a piece variant is missing or has a price of 0 or less: the cashier sells singles. */
export function buildBundleLines(
  offer: BundleOffer,
  product: Product,
  products: Product[],
  group: number,
  cart: CartItem[] = [],
): { lines: CartItem[]; needsSwap: Array<'atomizer' | 'vial'> } {
  const sizes: Array<[BundleRole, string]> = [
    ['large', offer.largeVariantSize],
    ['atomizer', offer.atomizerVariantSize],
    ['vial', offer.vialVariantSize],
  ]
  const variants = sizes.map(([, size]) => variantOf(product, size))
  const basis = variants.map((v) => Math.round(v?.price ?? 0))
  const price = Math.round(offer.price)
  if (variants.some((v) => !v) || basis.some((b) => !(b > 0)) || !(price > 0)) return { lines: [], needsSwap: [] }
  let shares: [number, number, number]
  try {
    shares = splitBundleAmount(price, basis as Basis)
  } catch {
    return { lines: [], needsSwap: [] }
  }
  const lines = sizes.map(([role, size], i): CartItem => ({
    productId: product.id,
    productName: product.name,
    variantSize: size,
    price: shares[i],
    quantity: 1,
    subtotal: shares[i],
    bundleGroup: group,
    bundleRole: role,
    bundlePrice: price,
    bundleBasisPrice: basis[i],
    bundleLine: offer.line,
    bundleSize: offer.size,
    bundleDiscount: 0,
  }))
  const needsSwap = (['atomizer', 'vial'] as const).filter((role) => {
    const l = lines.find((x) => x.bundleRole === role)
    const left = l ? stockLeft(products, cart, l.productId, l.variantSize) : null
    return left !== null && left <= 0
  })
  return { lines, needsSwap }
}

export interface SwapOption {
  productId: string
  productName: string
  variantSize: string
  price: number
  stock: number
}

/** Pieces the cashier may swap in: atomizer = any fragrance's, vial = the same line's only. In stock after the
 *  cart (untracked stock counts as in stock), price above 0, sorted by name, never the piece being replaced. */
export function swapCandidates(
  catalog: BundleCatalog | undefined,
  products: Product[],
  cart: CartItem[],
  role: 'atomizer' | 'vial',
  line: string,
  current?: { productId: string; variantSize: string },
): SwapOption[] {
  const out: SwapOption[] = []
  for (const piece of catalog?.pieces ?? []) {
    if (piece.role !== role) continue
    if (role === 'vial' && piece.line !== line) continue
    if (current && current.productId === piece.productId && current.variantSize === piece.variantSize) continue
    const product = products.find((p) => p.id === piece.productId)
    const variant = variantOf(product, piece.variantSize)
    if (!product || !variant || !(variant.price > 0)) continue
    const raw = Number.isFinite(variant.stock) ? variant.stock : null
    const left = raw === null ? Number.POSITIVE_INFINITY : raw - inCartQty(cart, product.id, variant.size)
    if (!(left > 0)) continue
    out.push({ productId: product.id, productName: product.name, variantSize: variant.size, price: variant.price, stock: left })
  }
  return out.sort((a, b) => a.productName.localeCompare(b.productName))
}

/** Reprices every bundle group to `bundlePrice` split over the pieces' basis prices (Diskon Bundle is 0 in
 *  Phase 3). Never throws: a group that is incomplete, has a basis of 0 or less, or a net under `minNet`
 *  keeps its prices. Returns the same object when nothing changed. */
export function repriceBundles(state: CashierState): CashierState {
  const groups = new Map<number, CartItem[]>()
  for (const c of state.cart) {
    if (c.bundleGroup == null) continue
    groups.set(c.bundleGroup, [...(groups.get(c.bundleGroup) ?? []), c])
  }
  if (groups.size === 0) return state
  const shareOf = new Map<CartItem, number>()
  for (const lines of groups.values()) {
    const by = (role: BundleRole) => lines.find((l) => l.bundleRole === role)
    const L = by('large')
    const A = by('atomizer')
    const V = by('vial')
    if (lines.length !== 3 || !L || !A || !V) continue
    const net = L.bundlePrice ?? 0
    const basis: Basis = [L.bundleBasisPrice ?? 0, A.bundleBasisPrice ?? 0, V.bundleBasisPrice ?? 0]
    try {
      if (basis.some((b) => !(b > 0)) || net < minNet(basis)) continue
      const shares = splitBundleAmount(net, basis)
      shareOf.set(L, shares[0])
      shareOf.set(A, shares[1])
      shareOf.set(V, shares[2])
    } catch {
      // a bad basis or price: keep the group as it is
    }
  }
  let changed = false
  const cart = state.cart.map((c) => {
    const share = shareOf.get(c)
    if (share === undefined || (c.price === share && c.subtotal === share && c.bundleDiscount === 0)) return c
    changed = true
    return { ...c, price: share, subtotal: share, bundleDiscount: 0 }
  })
  return changed ? { ...state, cart } : state
}

export type HeldBundleRebuild = { ok: true; lines: CartItem[] } | { ok: false; label: string }

/** A held bundle's three pieces, re-priced for a restore: `bundlePrice` from the current offer (matching the large
 *  piece's product, `bundleLine` and `bundleSize`), each basis from the piece variant's current price. Not ok
 *  (with a label for the note) when the offer, a piece variant or its price is gone. */
export function rebuildHeldBundle(lines: CartItem[], products: Product[], catalog: BundleCatalog | undefined): HeldBundleRebuild {
  const large = lines.find((l) => l.bundleRole === 'large')
  const label = large ? `${large.productName} ${bundleLabel(large.bundleLine ?? '', large.bundleSize ?? '')}`.trim() : 'bundle'
  if (!large || lines.length !== 3) return { ok: false, label }
  const offer = cardOffers(catalog, large.productId).find((o) => o.line === (large.bundleLine ?? '') && o.size === large.bundleSize)
  if (!offer || !(Math.round(offer.price) > 0)) return { ok: false, label }
  const out: CartItem[] = []
  for (const role of ['large', 'atomizer', 'vial'] as const) {
    const l = lines.find((x) => x.bundleRole === role)
    const price = variantOf(products.find((p) => p.id === l?.productId), l?.variantSize ?? '')?.price ?? 0
    if (!l || !(Math.round(price) > 0)) return { ok: false, label }
    out.push({ ...l, quantity: 1, bundlePrice: Math.round(offer.price), bundleBasisPrice: Math.round(price) })
  }
  const basis = out.map((l) => l.bundleBasisPrice ?? 0) as Basis
  const net = out[0].bundlePrice ?? 0
  if (net < minNet(basis)) return { ok: false, label }
  const shares = splitBundleAmount(net, basis)
  return { ok: true, lines: out.map((l, i) => ({ ...l, price: shares[i], subtotal: shares[i], bundleDiscount: 0 })) }
}

/** Display name of a line for sheet titles: `Ganti 2ml Extrait`. Empty for no line. */
export function lineLabel(line: string): string {
  if (line === 'EXTRAIT DE PARFUM') return 'Extrait'
  if (line === 'PARFUM INTENSE') return 'Parfum Intense'
  return line
}

/** The piece variant is at 0 or less, or the cart already sells more than its stock (so this piece oversells). */
export function pieceOut(products: Product[], cart: CartItem[], productId: string, size: string): boolean {
  const raw = stockFor(products, productId, size)
  return raw !== null && (raw <= 0 || raw - inCartQty(cart, productId, size) < 0)
}

export interface SwapFlow {
  group: number
  queue: Array<'atomizer' | 'vial'>
}

/** The swap sheets run in queue order (atomizer, then 2ml): closing, keeping or picking moves to the next. */
export function advanceSwapFlow(f: SwapFlow | null): SwapFlow | null {
  return f && f.queue.length > 1 ? { ...f, queue: f.queue.slice(1) } : null
}

/** `Bundle EXT 120ml` (or `Bundle 120ml` for a bundle without a line), from a catalog offer. */
export function offerLabel(offer: BundleOffer): string {
  return offer.lineShort ? `Bundle ${offer.lineShort} ${offer.size}` : `Bundle ${offer.size}`
}

/** `Ganti atomizer 10ml`, `Ganti 2ml Extrait` (`Ganti 2ml` when the bundle has no line). */
export function swapTitle(role: 'atomizer' | 'vial', line: string): string {
  if (role === 'atomizer') return 'Ganti atomizer 10ml'
  return `Ganti 2ml ${lineLabel(line)}`.trim()
}

