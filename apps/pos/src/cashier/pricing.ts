/**
 * DISPLAY ONLY — server is authoritative for all money/stock/loyalty.
 * These formulas mirror CashierScreen.tsx §9 (lines 320–389) for provisional
 * UI display only. Server recomputes everything in POST /orders.
 */

import type { components } from '@mandalika/api'
import type { AppliedPromoCode } from './promoValidate'

type Promotion = components['schemas']['Promotion']
type AppSettings = components['schemas']['AppSettings']
type LoyaltySettings = components['schemas']['LoyaltySettings']
type CartItem = components['schemas']['CartItem']
type Product = components['schemas']['Product']
type BXGYConfig = NonNullable<Promotion['bxgyConfig']>
type TieredConfig = NonNullable<Promotion['tieredConfig']>
type BundleConfig = NonNullable<Promotion['bundleConfig']>

/**
 * bundleApplications: how many complete bundle sets `items` supports, capped
 * by maxApplications (0 = unlimited). Mirrors Go bundleApplications 1:1.
 */
export function bundleApplications(
  cfg: BundleConfig | null | undefined,
  items: CartItem[],
): number {
  if (!cfg || cfg.slots.length === 0) return 0
  let n = -1
  for (const slot of cfg.slots) {
    if (slot.quantity < 1 || slot.productKeys.length === 0) return 0
    let units = 0
    for (const it of items) {
      if (keyMatchesLine(slot.productKeys, it.productId, it.variantSize)) units += it.quantity
    }
    const k = Math.floor(units / slot.quantity)
    if (n < 0 || k < n) n = k
  }
  if (n < 0) n = 0
  if (cfg.maxApplications && cfg.maxApplications > 0 && n > cfg.maxApplications) n = cfg.maxApplications
  return n
}

/**
 * bundleAllocate: NET price of each consumed unit after zeroing the cheapest
 * units first until the discount D = sum(prices) - bundlePrice*nApp is spent
 * (D floored at 0). Returned slice aligns to the input order. Stable sort
 * ascending on price mirrors Go's sort.SliceStable. Mirrors Go bundleAllocate 1:1.
 */
export function bundleAllocate(prices: number[], bundlePrice: number, nApp: number): number[] {
  const nets = [...prices]
  let d = prices.reduce((s, p) => s + p, 0) - bundlePrice * nApp
  if (d <= 0) return nets
  const idx = prices.map((_, i) => i).sort((a, b) => prices[a] - prices[b])
  for (const i of idx) {
    if (d <= 0) break
    if (prices[i] <= d) {
      nets[i] = 0
      d -= prices[i]
    } else {
      nets[i] = prices[i] - d
      d = 0
    }
  }
  return nets
}

export interface PricingResult {
  subtotal: number
  manualDiscountAmount: number
  promoDiscountAmount: number
  discountAmount: number
  taxableAmount: number
  taxAmount: number
  surchargeAmount: number
  redeemAmount: number
  redeemedPoints: number
  total: number
  earnedPoints: number
}

function bxgyVariantKey(productId: string, size: string): string {
  return `${productId}|${size}`
}
// keyMatchesLine: shared productKeys convention (`pid` or `pid|size`) used by
// both buy_x_get_y and bundle promos. Mirrors Go keyMatchesLine 1:1.
export function keyMatchesLine(keys: string[], productId: string, size: string): boolean {
  return keys.includes(productId) || (size !== '' && keys.includes(bxgyVariantKey(productId, size)))
}
function bxgyExpand(items: CartItem[], keys: string[], emptyMatchesAll: boolean): number[] {
  const prices: number[] = []
  for (const i of items) {
    let match = emptyMatchesAll
    if (keys.length > 0) match = keyMatchesLine(keys, i.productId, i.variantSize)
    if (!match) continue
    for (let n = 0; n < i.quantity; n++) prices.push(i.price)
  }
  return prices
}
function calcBXGY(cfg: BXGYConfig | null | undefined, items: CartItem[]): number {
  if (!cfg || cfg.buyQuantity < 1 || cfg.getQuantity < 1) return 0
  const buyKeys = cfg.buyProductIds ?? []
  const getKeys = cfg.getProductIds ?? []
  let getPool: number[]
  let nApp: number
  if (getKeys.length === 0) {
    const pool = bxgyExpand(items, buyKeys, true)
    nApp = Math.floor(pool.length / (cfg.buyQuantity + cfg.getQuantity))
    getPool = pool
  } else {
    let buyPool: number[]
    if (buyKeys.length === 0) {
      buyPool = []
      for (const i of items) {
        if (keyMatchesLine(getKeys, i.productId, i.variantSize)) continue
        for (let n = 0; n < i.quantity; n++) buyPool.push(i.price)
      }
    } else {
      buyPool = bxgyExpand(items, buyKeys, false)
    }
    getPool = bxgyExpand(items, getKeys, false)
    nApp = Math.floor(buyPool.length / cfg.buyQuantity)
    const g = Math.floor(getPool.length / cfg.getQuantity)
    if (g < nApp) nApp = g
  }
  const maxApp = cfg.maxApplications ?? 0
  if (maxApp > 0 && nApp > maxApp) nApp = maxApp
  if (nApp <= 0) return 0
  let nDiscount = nApp * cfg.getQuantity
  const sorted = [...getPool].sort((a, b) => a - b)
  if (nDiscount > sorted.length) nDiscount = sorted.length
  let total = 0
  for (let k = 0; k < nDiscount; k++) {
    if (cfg.getDiscountKind === 'percentage') total += Math.round(sorted[k] * (cfg.getDiscountValue / 100))
    else if (cfg.getDiscountKind === 'fixed') total += Math.min(cfg.getDiscountValue, sorted[k])
  }
  return total
}

/**
 * bxgyBuyUnits: count qty-expanded units that satisfy the buy set.
 * Empty buyProductIds → any unit NOT in the get set.
 */
function bxgyBuyUnits(c: BXGYConfig, items: CartItem[]): number {
  const getKeys = c.getProductIds ?? []
  const buyKeys = c.buyProductIds ?? []
  let n = 0
  for (const i of items) {
    const isBuy =
      buyKeys.length > 0
        ? keyMatchesLine(buyKeys, i.productId, i.variantSize)
        : !keyMatchesLine(getKeys, i.productId, i.variantSize)
    if (isBuy) n += i.quantity
  }
  return n
}

/**
 * bxgyRewardDue: number of reward units the cart earns (separate-set only).
 * Mirrors Go bxgyRewardDue 1:1.
 */
export function bxgyRewardDue(cfg: BXGYConfig | null | undefined, items: CartItem[]): number {
  if (!cfg || (cfg.getProductIds ?? []).length === 0 || cfg.buyQuantity < 1 || cfg.getQuantity < 1)
    return 0
  const maxApp = cfg.maxApplications ?? 0
  let nApp = Math.floor(bxgyBuyUnits(cfg, items) / cfg.buyQuantity)
  if (maxApp > 0 && nApp > maxApp) nApp = maxApp
  return Math.max(0, nApp) * cfg.getQuantity
}

/**
 * bxgyRewardNet: per-unit price charged for a reward (0 for free).
 * Mirrors Go bxgyRewardNet 1:1.
 */
export function bxgyRewardNet(cfg: BXGYConfig, fullPrice: number): number {
  if (cfg.getDiscountKind === 'percentage') {
    return fullPrice - Math.round(fullPrice * (cfg.getDiscountValue / 100))
  }
  if (cfg.getDiscountKind === 'fixed') {
    return Math.max(0, fullPrice - cfg.getDiscountValue)
  }
  return fullPrice
}

export interface BXGYRewardOption {
  productId: string
  productName: string
  variantSize: string
  fullPrice: number
  net: number
}

/**
 * bxgyRewardOptions: expand getProductIds against the product catalog into
 * selectable reward variants with their discounted net price.
 * Mirrors Go bxgyRewardOptions logic.
 */
export function bxgyRewardOptions(
  cfg: BXGYConfig | null | undefined,
  products: Product[],
): BXGYRewardOption[] {
  if (!cfg) return []
  const getKeys = cfg.getProductIds ?? []
  if (getKeys.length === 0) return []
  const result: BXGYRewardOption[] = []
  for (const p of products) {
    for (const v of p.variants) {
      const size = v.size
      if (!keyMatchesLine(getKeys, p.id, size)) continue
      result.push({
        productId: p.id,
        productName: p.name,
        variantSize: size,
        fullPrice: v.price,
        net: bxgyRewardNet(cfg, v.price),
      })
    }
  }
  return result
}

export function pickTier(cfg: TieredConfig | null | undefined, sub: number) {
  if (!cfg?.tiers) return null
  let best: TieredConfig['tiers'][number] | null = null
  for (const t of cfg.tiers) if (sub >= t.minSubtotal && (!best || t.minSubtotal > best.minSubtotal)) best = t
  return best
}

export function tieredNextTier(cfg: TieredConfig | null | undefined, sub: number) {
  if (!cfg?.tiers) return null
  let next: TieredConfig['tiers'][number] | null = null
  for (const t of cfg.tiers) if (t.minSubtotal > sub && (!next || t.minSubtotal < next.minSubtotal)) next = t
  return next ? { ...next, gap: next.minSubtotal - sub } : null
}

export function calcPromoDiscount(
  promo: Promotion,
  items: CartItem[],
  sub: number,
): number {
  if (promo.type === 'buy_x_get_y') {
    const cfg = promo.bxgyConfig
    // separate-set is a reward giveaway: the saving lives in the reward line's
    // reduced price, so it contributes 0 here. same-set discounts in place.
    if (cfg && (cfg.getProductIds ?? []).length > 0) return 0
    return calcBXGY(cfg, items)
  }
  if (promo.type === 'tiered') {
    const t = pickTier(promo.tieredConfig, sub)
    if (!t) return 0
    if (t.kind === 'percentage') return Math.round(sub * (t.value / 100))
    if (t.kind === 'fixed') return Math.min(t.value, sub)
    return 0
  }
  if (promo.type === 'bundle') {
    // saving is realized as zeroed reward lines (server resolveBundleLines), so the
    // promo contributes 0 to the additive stack — mirrors buy_x_get_y separate-set.
    return 0
  }
  const matchingItems =
    promo.applicableProductIds && promo.applicableProductIds.length > 0
      ? items.filter((i) => promo.applicableProductIds!.includes(i.productId))
      : items
  const matchingSubtotal = matchingItems.reduce((s, i) => s + i.subtotal, 0)
  if (
    matchingItems.length === 0 &&
    promo.applicableProductIds &&
    promo.applicableProductIds.length > 0
  )
    return 0
  if (promo.type === 'percentage')
    return Math.round(
      (matchingItems.length > 0 ? matchingSubtotal : sub) * (promo.value / 100),
    )
  if (promo.type === 'fixed') return Math.min(promo.value, sub)
  if (promo.type === 'bogo') {
    const prices = matchingItems.flatMap((i) =>
      Array.from({ length: i.quantity }, () => i.price),
    )
    prices.sort((a, b) => a - b)
    return prices.length >= 2 ? prices[0] : 0
  }
  return 0
}

export interface PricingInput {
  cart: CartItem[]
  discountType: 'percentage' | 'fixed'
  surchargeType: 'percentage' | 'fixed'
  discountRunning: number
  surchargeRunning: number
  appliedPromotions: Promotion[]
  appliedPromoCodes: AppliedPromoCode[]
  settings: AppSettings
  loyalty: LoyaltySettings
  hasCustomer: boolean
  pointsRedeemed: number
  customerPoints: number
}

/**
 * Build the Promotion-shaped object needed by calcPromoDiscount for a linked
 * AppliedPromoCode. All three sites that needed this shape (pricing.ts,
 * PromoPanel.tsx, CashierScreen.tsx) use this helper so they can never desync.
 */
export function linkedPromoShape(c: AppliedPromoCode): Promotion {
  if (!c.promotion) throw new Error('linkedPromoShape called on unlinked code')
  return {
    id: c.promotion.id,
    name: c.code,
    type: c.promotion.type as Promotion['type'],
    value: c.promotion.value,
    applicableProductIds: c.promotion.applicableProductIds ?? null,
    bxgyConfig: c.promotion.bxgyConfig ?? null,
    isActive: true,
    createdAt: '',
  }
}

export function computePricing(input: PricingInput): PricingResult {
  const {
    cart,
    discountType,
    surchargeType,
    discountRunning,
    surchargeRunning,
    appliedPromotions,
    appliedPromoCodes,
    settings,
    loyalty,
    hasCustomer,
    pointsRedeemed,
    customerPoints,
  } = input

  const subtotal = cart.reduce((s, i) => s + i.subtotal, 0)

  const manualDiscountAmount =
    discountRunning > 0
      ? discountType === 'percentage'
        ? Math.round(subtotal * (discountRunning / 100))
        : Math.min(discountRunning, subtotal)
      : 0

  const surchargeAmount =
    surchargeRunning > 0
      ? surchargeType === 'percentage'
        ? Math.round(subtotal * (surchargeRunning / 100))
        : surchargeRunning
      : 0

  const promoDiscountAmount =
    appliedPromotions.reduce((sum, p) => sum + calcPromoDiscount(p, cart, subtotal), 0) +
    appliedPromoCodes.reduce((sum, c) => {
      // SP-Promo-3c: linked codes carry a promotion snapshot; delegate to the
      // same calcPromoDiscount used for appliedPromotions so BOGO/scoping work.
      if (c.promotion) {
        return sum + calcPromoDiscount(linkedPromoShape(c), cart, subtotal)
      }
      // Unlinked code: flat percentage or fixed discount off the whole cart
      return sum + (c.type === 'percentage'
        ? Math.round(subtotal * (c.value / 100))
        : Math.min(c.value, subtotal))
    }, 0)

  const discountAmount = Math.min(
    manualDiscountAmount + promoDiscountAmount,
    subtotal,
  )
  const taxableAmount = subtotal - discountAmount
  const taxAmount = settings.taxEnabled
    ? Math.round(taxableAmount * (settings.taxRate / 100))
    : 0

  let total = taxableAmount + taxAmount + surchargeAmount
  if (settings.roundingEnabled) {
    const roundTo =
      settings.roundingType === 'nearest_1000'
        ? 1000
        : settings.roundingType === 'nearest_500'
          ? 500
          : 1
    total = Math.round(total / roundTo) * roundTo
  }

  const earnedPoints =
    loyalty.enabled && hasCustomer
      ? Math.floor(total / 1000) * loyalty.pointsPerThousand
      : 0

  // Loyalty redemption — display mirror; server is authoritative. Clamp to
  // available points and to the order total (cannot pay a negative bill).
  const rate = loyalty.redemptionRate || 0
  let redeemedPoints = 0
  let redeemAmount = 0
  if (loyalty.enabled && hasCustomer && pointsRedeemed > 0 && rate > 0) {
    redeemedPoints = Math.min(pointsRedeemed, customerPoints)
    redeemAmount = Math.min(Math.round(redeemedPoints * rate), total)
    redeemedPoints = Math.min(redeemedPoints, Math.floor(redeemAmount / rate))
  }
  total = total - redeemAmount

  return {
    subtotal,
    manualDiscountAmount,
    promoDiscountAmount,
    discountAmount,
    taxableAmount,
    taxAmount,
    surchargeAmount,
    redeemAmount,
    redeemedPoints,
    total,
    earnedPoints,
  }
}

// Hoisted once: Intl constructors allocate locale-data tables per call.
const RUPIAH_FORMAT = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
})

export function formatRupiah(amount: number): string {
  return RUPIAH_FORMAT.format(amount)
}
