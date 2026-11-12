import type { components } from '@mandalika/api'
import { bundleApplications, bxgyRewardDue } from './pricing'
import { bundleDiscountMatches } from './setBundles'
import { BUNDLE_DISCOUNT_UNMET } from './promoCopy'

type Promotion = components['schemas']['Promotion']
type CartItem = components['schemas']['CartItem']

/** Which cart precondition (beyond date/min/day/hours gating) a promo fails. */
export type UnmetPrecondition = 'bxgy' | 'bundle' | 'bundle-discount'

/** SEPARATE-SET buy_x_get_y (non-empty getProductIds) is a reward giveaway. */
export function isSeparateSetBxgy(promo: Promotion): boolean {
  return promo.type === 'buy_x_get_y' && (promo.bxgyConfig?.getProductIds ?? []).length > 0
}

/**
 * Cart precondition gating (`validatePromo`) cannot see, shared by the Promo
 * panel and the auto-apply reconcile so they can never drift.
 *
 * - buy_x_get_y separate-set: the buy criteria must earn at least one reward
 *   unit. SAME-SET discounts in place, so it needs `savings > 0`.
 * - bundle: at least one complete set must be buildable from the paid lines.
 * - bundle_discount: at least one bundle in the cart must match its lines/sizes.
 *
 * `candidateCart` is the cart as it will be once the promo is selected
 * (takeover / exclusive restoration already applied); `savings` is
 * `calcPromoDiscount(promo, cart, subtotal)`. Caller skips this when gating
 * already failed.
 */
export function unmetCartPrecondition(
  promo: Promotion,
  candidateCart: CartItem[],
  savings: number,
): UnmetPrecondition | null {
  if (promo.type === 'buy_x_get_y') {
    const unmet = isSeparateSetBxgy(promo)
      ? bxgyRewardDue(promo.bxgyConfig, candidateCart.filter((c) => !c.isReward && c.bundleGroup == null)) < 1
      : savings <= 0
    return unmet ? 'bxgy' : null
  }
  if (promo.type === 'bundle_discount') return bundleDiscountMatches(promo, candidateCart) ? null : 'bundle-discount'
  if (
    promo.type === 'bundle' &&
    bundleApplications(promo.bundleConfig, candidateCart.filter((c) => !c.isReward && c.bundleGroup == null)) < 1
  ) {
    return 'bundle'
  }
  return null
}

export function unmetPreconditionLabel(unmet: UnmetPrecondition): string {
  if (unmet === 'bundle-discount') return BUNDLE_DISCOUNT_UNMET
  return unmet === 'bxgy' ? 'Syarat beli belum terpenuhi' : 'Syarat bundle belum terpenuhi'
}
