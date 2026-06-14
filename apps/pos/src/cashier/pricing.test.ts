import { describe, it, expect } from 'vitest'
import { computePricing, type PricingInput } from './pricing'

const base: Omit<PricingInput, 'appliedPromotions' | 'appliedPromoCodes'> = {
  cart: [{ productId: 'a', productName: 'A', variantSize: '', price: 100000, quantity: 1, subtotal: 100000 } as any],
  discountType: 'fixed',
  surchargeType: 'fixed',
  discountRunning: 0,
  surchargeRunning: 0,
  settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as any,
  loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as any,
  hasCustomer: false,
  pointsRedeemed: 0,
  customerPoints: 0,
}

describe('computePricing stacking', () => {
  it('sums two combinable promotions additively off subtotal', () => {
    const p = (id: string, value: number) =>
      ({ id, name: id, type: 'percentage', value, combinable: true }) as any
    const res = computePricing({ ...base, appliedPromotions: [p('a', 10), p('b', 5)], appliedPromoCodes: [] })
    expect(res.promoDiscountAmount).toBe(15000) // 10k + 5k off 100k
    expect(res.discountAmount).toBe(15000)
  })

  it('adds promotion + code discounts together', () => {
    const promo = { id: 'a', name: 'A', type: 'percentage', value: 10, combinable: true } as any
    const res = computePricing({
      ...base,
      appliedPromotions: [promo],
      appliedPromoCodes: [{ code: 'X', value: 20000, type: 'fixed' }],
    })
    expect(res.promoDiscountAmount).toBe(30000) // 10k + 20k
  })

  it('empty arrays = no promo discount', () => {
    const res = computePricing({ ...base, appliedPromotions: [], appliedPromoCodes: [] })
    expect(res.promoDiscountAmount).toBe(0)
  })
})
