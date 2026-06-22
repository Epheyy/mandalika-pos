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
type BXGYConfig = NonNullable<Promotion['bxgyConfig']>

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
function bxgyKeyMatches(keys: string[], productId: string, size: string): boolean {
  return keys.includes(productId) || (size !== '' && keys.includes(bxgyVariantKey(productId, size)))
}
function bxgyExpand(items: CartItem[], keys: string[], emptyMatchesAll: boolean): number[] {
  const prices: number[] = []
  for (const i of items) {
    let match = emptyMatchesAll
    if (keys.length > 0) match = bxgyKeyMatches(keys, i.productId, i.variantSize)
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
        if (bxgyKeyMatches(getKeys, i.productId, i.variantSize)) continue
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

export function calcPromoDiscount(
  promo: Promotion,
  items: CartItem[],
  sub: number,
): number {
  if (promo.type === 'buy_x_get_y') return calcBXGY(promo.bxgyConfig, items)
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
