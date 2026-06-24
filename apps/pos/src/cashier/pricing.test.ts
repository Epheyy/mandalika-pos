import { describe, it, expect } from 'vitest'
import { computePricing, calcPromoDiscount, type PricingInput } from './pricing'
import type { components } from '@mandalika/api'

type CartItem = components['schemas']['CartItem']
type Promotion = components['schemas']['Promotion']
type BXGYConfig = NonNullable<Promotion['bxgyConfig']>

const ci = (productId: string, variantSize: string, price: number, quantity: number): CartItem => ({
  productId, productName: 'P', variantSize, price, quantity, subtotal: price * quantity,
})
const bxgy = (cfg: BXGYConfig): Promotion => ({
  id: 'p1', name: 'BXGY', type: 'buy_x_get_y', value: 0, isActive: true, createdAt: '', bxgyConfig: cfg,
})
const sub = (items: CartItem[]) => items.reduce((s, i) => s + i.subtotal, 0)

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

describe('calcPromoDiscount buy_x_get_y (parity with Go calcBXGY)', () => {
  it('same-set buy2get1 free → cheapest unit free', () => {
    const items = [ci('a', 'M', 10000, 3)]
    expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 }), items, sub(items))).toBe(10000)
  })
  it('repeats and respects maxApplications cap', () => {
    const items = [ci('a', 'M', 10000, 6)]
    expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 }), items, sub(items))).toBe(20000)
    expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100, maxApplications: 1 }), items, sub(items))).toBe(10000)
  })
  it('separate set percentage + scarcity', () => {
    const cfg: BXGYConfig = { buyQuantity: 2, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b'], getDiscountKind: 'percentage', getDiscountValue: 50 }
    const items = [ci('a', 'M', 10000, 2), ci('b', 'M', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), items, sub(items))).toBe(4000)
    const items0 = [ci('a', 'M', 10000, 1), ci('b', 'M', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), items0, sub(items0))).toBe(0)
  })
  it('fixed get discount capped at unit price', () => {
    const items = [ci('a', 'M', 5000, 2)]
    expect(calcPromoDiscount(bxgy({ buyQuantity: 1, getQuantity: 1, getDiscountKind: 'fixed', getDiscountValue: 99999 }), items, sub(items))).toBe(5000)
  })
  it('variant-level get key matches only the right variant', () => {
    const cfg: BXGYConfig = { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b|10ml'], getDiscountKind: 'percentage', getDiscountValue: 100 }
    const wrong = [ci('a', 'M', 10000, 1), ci('b', '50ml', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), wrong, sub(wrong))).toBe(0)
    const right = [ci('a', 'M', 10000, 1), ci('b', '10ml', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), right, sub(right))).toBe(8000)
  })
  it('missing bxgyConfig → 0', () => {
    const items = [ci('a', 'M', 10000, 3)]
    const promo: Promotion = { id: 'p1', name: 'x', type: 'buy_x_get_y', value: 0, isActive: true, createdAt: '' }
    expect(calcPromoDiscount(promo, items, sub(items))).toBe(0)
  })
  it('separate-set: unrelated/under-qualified cart → 0 (PromoPanel gate basis — bug repro)', () => {
    // Mirrors the on-device report: buy 2 Gorgeous, get 1 Holy Sweet 10ml free.
    const cfg: BXGYConfig = {
      buyQuantity: 2, getQuantity: 1, buyProductIds: ['gorgeous'],
      getProductIds: ['holysweet|10ml ATOMIZER'], getDiscountKind: 'percentage', getDiscountValue: 100,
    }
    const unrelated = [ci('random', 'M', 50000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), unrelated, sub(unrelated))).toBe(0)
    const buyOnly = [ci('gorgeous', 'M', 100000, 2)]
    expect(calcPromoDiscount(bxgy(cfg), buyOnly, sub(buyOnly))).toBe(0)
    const met = [ci('gorgeous', 'M', 100000, 2), ci('holysweet', '10ml ATOMIZER', 75000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), met, sub(met))).toBe(75000)
  })
})

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
