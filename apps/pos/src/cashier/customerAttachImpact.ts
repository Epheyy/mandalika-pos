import type { components } from '@mandalika/api'
import type { CashierState } from './state/cashierReducer'

type Promotion = components['schemas']['Promotion']

/** Separate-set BXGY (a giveaway) and bundles move or add physical lines; SET_CUSTOMER strips them. */
function isPhysicalPromotion(p: Pick<Promotion, 'type' | 'bxgyConfig'> | { type: string; bxgyConfig?: Promotion['bxgyConfig'] }): boolean {
  return p.type === 'bundle' || (p.type === 'buy_x_get_y' && (p.bxgyConfig?.getProductIds ?? []).length > 0)
}

/**
 * Names of what `SET_CUSTOMER` would silently remove from the draft sale. Mirrors the reducer's rule
 * (cashierReducer 'SET_CUSTOMER') without changing it: every reward line goes, bundles with a freed
 * set go, linked codes whose promotion is a bundle or a giveaway go, and redeemed points reset.
 * Promos the auto-apply installed are NOT listed: the reconcile re-installs them straight away (eligibility does not
 * depend on the customer), so warning about them would warn about nothing lost. Only manual ones count.
 * Empty array = attaching is lossless, so no confirm is needed.
 */
export function customerAttachImpact(
  state: Pick<CashierState, 'cart' | 'appliedPromotions' | 'appliedPromoCodes' | 'bundleFreed' | 'pointsToRedeem'> & Partial<Pick<CashierState, 'autoPromotionIds'>>,
): string[] {
  const auto = state.autoPromotionIds ?? []
  const names: string[] = []
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name)
  }
  const promoName = (id: string): string | undefined => state.appliedPromotions.find((p) => p.id === id)?.name

  for (const item of state.cart) {
    if (!item.isReward) continue
    if (item.rewardPromotionId && auto.includes(item.rewardPromotionId)) continue
    // A promo reward line is reported under its promo's name; a loyalty reward under the product.
    add((item.rewardPromotionId && promoName(item.rewardPromotionId)) || `Hadiah ${item.productName}`)
  }
  for (const p of state.appliedPromotions) {
    if (p.id in state.bundleFreed && !auto.includes(p.id)) add(p.name)
  }
  for (const c of state.appliedPromoCodes) {
    if (c.promotion && isPhysicalPromotion(c.promotion)) add(`Kode Promo ${c.code}`)
  }
  if (state.pointsToRedeem > 0) add('poin yang ditukar')
  return names
}

/** Confirm copy for the attach/replace/release cases; the list reads "a, b dan c". */
export function customerAttachMessage(names: string[], change: 'attach' | 'replace' | 'release'): string {
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} dan ${names[names.length - 1]}` : names[0]
  const verb = change === 'attach' ? 'Menambahkan pelanggan' : change === 'replace' ? 'Mengganti pelanggan' : 'Melepas pelanggan'
  return `${verb} akan menghapus ${list}. Lanjutkan?`
}
