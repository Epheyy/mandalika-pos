/**
 * Wiring helpers for promo auto-apply (plan 2026-11-05 §2.1, §2.6, §2.7). Pure: the screen owns the effect and the
 * dispatch; these decide WHEN the reconcile must run, whether it is allowed to, and whether it would change the sale.
 */

import type { components } from '@mandalika/api'
import { reconcileAutoPromos, type AutoPromoContext } from './autoPromos'
import type { CashierState } from './state/cashierReducer'

type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']

/** True when the catalogue has any promotion the reconcile could act on. False = today's behaviour, nothing runs. */
export const hasAutoPromotions = (promotions: readonly Promotion[]): boolean =>
  promotions.some((p) => p.isActive && p.autoApply === true && !p.codeOnly)

/**
 * Identity of everything the reconcile reads: the RUNG cart (paid lines with every bundle's moved units put back, so
 * installing an auto bundle never changes it), the manual promos and codes, the dismissed set, the customer, the
 * promotions snapshot and the clock minute. The effect keys on this string, so an install cannot re-trigger itself.
 */
export function autoReconcileFingerprint(
  state: Pick<CashierState, 'cart' | 'appliedPromotions' | 'appliedPromoCodes' | 'autoPromotionIds' | 'dismissedAutoPromotionIds' | 'selectedCustomer' | 'bundleFreed'>,
  promotions: readonly Promotion[],
  minute: number,
): string {
  const paid = new Map<string, number>()
  const add = (productId: string, size: string, qty: number) => paid.set(`${productId}|${size}`, (paid.get(`${productId}|${size}`) ?? 0) + qty)
  for (const c of state.cart) if (!c.isReward) add(c.productId, c.variantSize, c.quantity)
  for (const freed of Object.values(state.bundleFreed)) for (const f of freed) add(f.productId, f.variantSize, f.quantity)
  // Non-bundle reward lines are not rung; bundle reward lines are, through bundleFreed (restored above).
  return JSON.stringify([
    [...paid.entries()].sort(),
    state.appliedPromotions.filter((p) => !state.autoPromotionIds.includes(p.id)).map((p) => p.id).sort(),
    state.appliedPromoCodes.map((c) => c.code).sort(),
    [...state.dismissedAutoPromotionIds].sort(),
    state.selectedCustomer?.id ?? null,
    promotions.filter((p) => p.autoApply === true).map((p) => JSON.stringify(p)).sort(),
    minute,
  ])
}

export interface AutoRunGates {
  catalogueReady: boolean
  pickerPending: boolean
  successOpen: boolean
  confirmOpen: boolean
  checkoutOpen: boolean
  processing: boolean
  splitLocked: boolean
}

/** The reconcile never moves the total under a picker, a confirm, a payment sheet or entered payment lines. */
export const autoRunAllowed = (g: AutoRunGates): boolean =>
  g.catalogueReady && !g.pickerPending && !g.successOpen && !g.confirmOpen && !g.checkoutOpen && !g.processing && !g.splitLocked

/** Confirm time (§2.7): would the reconcile change the sale the cashier is about to pay? (Prompts alone do not count.) */
export function autoSetWouldChange(
  state: CashierState,
  env: { promotions: readonly Promotion[]; products: readonly Product[]; ctx: AutoPromoContext },
): boolean {
  if (!hasAutoPromotions(env.promotions) && state.autoPromotionIds.length === 0) return false
  return reconcileAutoPromos({
    state,
    autoPromotionIds: state.autoPromotionIds,
    dismissedPromotionIds: state.dismissedAutoPromotionIds,
    promotions: env.promotions,
    products: env.products,
    ctx: env.ctx,
  }).changed
}
