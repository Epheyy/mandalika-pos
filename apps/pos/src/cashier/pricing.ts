/**
 * DISPLAY ONLY — server is authoritative for all money/stock/loyalty.
 * These formulas mirror CashierScreen.tsx §9 (lines 320–389) for provisional
 * UI display only. Server recomputes everything in POST /orders.
 */

import type { components } from '@mandalika/api'

type Promotion = components['schemas']['Promotion']
type AppSettings = components['schemas']['AppSettings']
type LoyaltySettings = components['schemas']['LoyaltySettings']
type CartItem = components['schemas']['CartItem']

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

export function calcPromoDiscount(
  promo: Promotion,
  items: CartItem[],
  sub: number,
): number {
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
  discountRunning: number
  surchargeRunning: number
  appliedPromotion: Promotion | null
  appliedPromoCode: { code: string; value: number; type: 'percentage' | 'fixed' } | null
  settings: AppSettings
  loyalty: LoyaltySettings
  hasCustomer: boolean
  pointsRedeemed: number
  customerPoints: number
}

export function computePricing(input: PricingInput): PricingResult {
  const {
    cart,
    discountType,
    discountRunning,
    surchargeRunning,
    appliedPromotion,
    appliedPromoCode,
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
      ? discountType === 'percentage'
        ? Math.round(subtotal * (surchargeRunning / 100))
        : surchargeRunning
      : 0

  const promoDiscountAmount = appliedPromotion
    ? calcPromoDiscount(appliedPromotion, cart, subtotal)
    : appliedPromoCode
      ? appliedPromoCode.type === 'percentage'
        ? Math.round(subtotal * (appliedPromoCode.value / 100))
        : Math.min(appliedPromoCode.value, subtotal)
      : 0

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

export function getCustomerTier(spent: number): string {
  if (spent >= 5_000_000) return 'Platinum'
  if (spent >= 2_000_000) return 'Gold'
  if (spent >= 500_000) return 'Silver'
  return 'Member'
}

export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount)
}
