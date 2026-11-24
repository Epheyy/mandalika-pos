import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { cashierReducer, CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'
import { decideApplyCode, type AppliedPromoCode } from './promoValidate'
import { computePricing, type PricingInput } from './pricing'
import type { PromotionOwner } from './promotionFulfillment'

// A23 mirror of the server matrix in TestPromoLinkedParityPostgres (same prices, same promotions, same totals):
// a promotion priced directly and through a linked code must give the same money and the same physical cart.
type Promotion = components['schemas']['Promotion']
type CartItem = components['schemas']['CartItem']
type Product = components['schemas']['Product']
const P1 = 'p1', P2 = 'p2'
const prices: Record<string, number> = { [P1]: 100000, [P2]: 50000 }
const line = (id: string, qty = 1): CartItem => ({ productId: id, productName: id, variantSize: 'M', price: prices[id], quantity: qty, subtotal: prices[id] * qty })
const catalog: Product[] = [P1, P2].map(id => ({ id, name: id, brand: 'PL', categoryId: '', isFeatured: false, isFavourite: false, isActive: true, createdAt: '',
  variants: [{ size: 'M', price: prices[id], stock: 100, sku: `pl-${id}` }] }))
const promo = (extra: Partial<Promotion> & Pick<Promotion, 'type' | 'value'>): Promotion => ({ id: 'promo', name: 'PL', isActive: true, createdAt: '', combinable: true, codeOnly: false, ...extra })
const ctx = { now: new Date('2026-09-20T05:00:00Z'), outletId: 'outlet', subtotal: 150000, hasCustomer: false }
const selectCode = (p: Promotion): AppliedPromoCode => {
  const r = decideApplyCode('raw-pl', [{ id: 'c', code: 'Raw-PL', promotionId: p.id, type: 'fixed', value: 987, usageCount: 0, isActive: true, createdAt: '' }], ctx, [p])
  if (!r.ok) throw new Error(r.reason)
  return r.code
}
const money = (s: CashierState) => {
  const input: PricingInput = { cart: s.cart, appliedPromotions: s.appliedPromotions, appliedPromoCodes: s.appliedPromoCodes, discountType: 'fixed', surchargeType: 'fixed',
    discountRunning: 0, surchargeRunning: 0, settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as PricingInput['settings'],
    loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as PricingInput['loyalty'], hasCustomer: false, pointsRedeemed: 0, customerPoints: 0 }
  const r = computePricing(input)
  return { total: r.total, discount: r.promoDiscountAmount, parts: r.discountParts.map(d => d.amount) }
}
const apply = (cart: CartItem[], owner: PromotionOwner): CashierState =>
  cashierReducer({ ...CASHIER_INITIAL_STATE, cart }, { type: 'APPLY_FULFILLMENT', owner, products: catalog })

const cases: { name: string; promo: Promotion; cart: CartItem[]; total: number; discount: number; rewardNet?: number }[] = [
  { name: 'tiered', promo: promo({ type: 'tiered', value: 0, tieredConfig: { tiers: [{ minSubtotal: 50000, kind: 'percentage', value: 10 }] } }), cart: [line(P1)], total: 90000, discount: 10000 },
  { name: 'scoped percentage', promo: promo({ type: 'percentage', value: 20, applicableProductIds: [P1] }), cart: [line(P1), line(P2)], total: 130000, discount: 20000 },
  { name: 'bogo', promo: promo({ type: 'bogo', value: 0 }), cart: [line(P2, 2)], total: 50000, discount: 50000 },
  { name: 'fixed amount', promo: promo({ type: 'fixed', value: 7000 }), cart: [line(P1), line(P2)], total: 143000, discount: 7000 },
  { name: 'unscoped percentage', promo: promo({ type: 'percentage', value: 10 }), cart: [line(P1), line(P2)], total: 135000, discount: 15000 },
]
const physical: { name: string; promo: Promotion; cart: CartItem[]; total: number; rewardNet: number }[] = [
  { name: 'separate-set buy_x_get_y', cart: [line(P1)], total: 125000, rewardNet: 25000,
    promo: promo({ type: 'buy_x_get_y', value: 0, bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: [P1], getProductIds: [P2], getDiscountKind: 'percentage', getDiscountValue: 50 } }) },
  { name: 'bundle', cart: [line(P1), line(P2)], total: 120000, rewardNet: 20000,
    promo: promo({ type: 'bundle', value: 0, bundleConfig: { slots: [{ productKeys: [P1], quantity: 1 }, { productKeys: [P2], quantity: 1 }], bundlePrice: 120000 } }) },
]

describe('A23 direct equals linked, same vectors as the server matrix', () => {
  it.each(cases)('$name', ({ promo: p, cart, total, discount }) => {
    const direct = money({ ...CASHIER_INITIAL_STATE, cart, appliedPromotions: [p] })
    const linked = money({ ...CASHIER_INITIAL_STATE, cart, appliedPromoCodes: [selectCode(p)] })
    expect(direct.total).toBe(total)
    expect(direct.discount).toBe(discount)
    expect(linked.total).toBe(direct.total)
    expect(linked.discount).toBe(direct.discount)
    expect(linked.parts).toEqual(direct.parts)
  })

  it.each(physical)('$name builds the same cart and total', ({ promo: p, cart, total, rewardNet }) => {
    const direct = apply(cart, { kind: 'direct', promotion: p })
    const linked = apply(cart, { kind: 'code', code: selectCode(p) })
    expect(linked.cart).toEqual(direct.cart)
    expect(money(linked).total).toBe(total)
    expect(money(direct).total).toBe(total)
    const reward = (s: CashierState) => s.cart.filter(c => c.isReward).reduce((n, c) => n + c.subtotal, 0)
    expect(reward(direct)).toBe(rewardNet)
    expect(reward(linked)).toBe(rewardNet)
  })
})
