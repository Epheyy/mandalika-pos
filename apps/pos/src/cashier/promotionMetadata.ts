import type { CashierState } from './state/cashierReducer'
import { calcPromoDiscount, linkedPromoShape } from './pricing'
import { effectivePromotionSelection } from './promotionSelection'

// The checkout uses this same projection for IDs, usage intent and displayed
// discount evidence. Only a newly captured order uses it; outbox data is untouched.
export function buildPromotionMetadata(
  state: Pick<CashierState, 'cart' | 'appliedPromotions' | 'appliedPromoCodes' | 'appliedDiscountType' | 'discountRunning'>,
  derived: { subtotal: number; manualDiscountAmount: number },
) {
  const { appliedPromotions, appliedPromoCodes } = effectivePromotionSelection(state.appliedPromotions, state.appliedPromoCodes)
  const discountBreakdown = [
    ...(derived.manualDiscountAmount > 0 ? [{
      label: 'Diskon Manual', kind: state.appliedDiscountType,
      value: state.discountRunning, amount: derived.manualDiscountAmount,
    }] : []),
    ...appliedPromotions.map(p => ({
      label: p.name, kind: p.type, value: p.value,
      amount: calcPromoDiscount(p, state.cart, derived.subtotal),
    })),
    ...appliedPromoCodes.map(c => ({
      label: c.code, kind: c.promotion ? c.promotion.type : c.type,
      value: c.promotion ? c.promotion.value : c.value,
      amount: c.promotion
        ? calcPromoDiscount(linkedPromoShape(c), state.cart, derived.subtotal)
        : c.type === 'percentage'
          ? Math.round(derived.subtotal * (c.value / 100))
          : Math.min(c.value, derived.subtotal),
    })),
  ]
  return {
    promotionIds: appliedPromotions.map(p => p.id),
    discountCodes: appliedPromoCodes.map(c => c.code),
    promotionId: appliedPromotions[0]?.id ?? null,
    discountCode: appliedPromoCodes[0]?.code ?? null,
    discountLabel: appliedPromotions[0]?.name ?? appliedPromoCodes[0]?.code ?? (state.discountRunning > 0 ? 'Diskon Manual' : null),
    discountBreakdown: discountBreakdown.length ? discountBreakdown : null,
  }
}
