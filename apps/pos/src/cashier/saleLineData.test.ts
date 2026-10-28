import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { refundGroups, withSaleLineData, discountComponents, type SaleLineDataInput } from './saleLineData'

type CartItem = components['schemas']['CartItem']
type Promotion = components['schemas']['Promotion']

const line = (productId: string, price: number, quantity = 1, extra: Partial<CartItem> = {}): CartItem =>
  ({ productId, productName: productId, variantSize: '', price, quantity, subtotal: price * quantity, ...extra }) as CartItem
const promo = (id: string, type: Promotion['type'], extra: Partial<Promotion> = {}): Promotion =>
  ({ id, name: id, type, value: 0, isActive: true, createdAt: '', ...extra }) as Promotion

const base = (over: Partial<SaleLineDataInput> = {}): SaleLineDataInput => ({
  cart: [], appliedPromotions: [], appliedPromoCodes: [], discountType: 'percentage', discountRunning: 0, total: 0, knownPromotions: [], ...over,
})
const nets = (r: CartItem[] | null) => r?.map((l) => l.netAmount)

describe('withSaleLineData (net per line, local sale)', () => {
  it('no discount: net = subtotal, sums to the total', () => {
    const cart = [line('a', 100000), line('b', 50000, 2)]
    const r = withSaleLineData(base({ cart, total: 200000 }))
    expect(nets(r)).toEqual([100000, 100000])
    expect(r!.map((l) => l.refundGroup)).toEqual([null, null])
  })

  it('tax spread over lines, last line settles the rounding', () => {
    const cart = [line('a', 100000), line('b', 50000)]
    expect(nets(withSaleLineData(base({ cart, total: 166500 })))).toEqual([111000, 55500])
  })

  it('a scoped promo only discounts its own product', () => {
    const cart = [line('a', 100000), line('b', 100000)]
    const p = promo('p1', 'fixed', { value: 20000, applicableProductIds: ['a'] })
    expect(nets(withSaleLineData(base({ cart, appliedPromotions: [p], total: 180000 })))).toEqual([80000, 100000])
  })

  it('a manual percentage discount spreads over every line', () => {
    const cart = [line('a', 60000), line('b', 40000)]
    expect(nets(withSaleLineData(base({ cart, discountRunning: 10, total: 90000 })))).toEqual([54000, 36000])
  })

  it('an unlinked code is a whole-cart discount', () => {
    const cart = [line('a', 60000), line('b', 40000)]
    const code = { code: 'HEMAT', type: 'fixed' as const, value: 10000 }
    expect(nets(withSaleLineData(base({ cart, appliedPromoCodes: [code], total: 90000 })))).toEqual([54000, 36000])
  })

  it('redeemed points (a lower total than the discounted lines) reduce the lines proportionally', () => {
    const cart = [line('a', 50000), line('b', 50000)]
    expect(nets(withSaleLineData(base({ cart, total: 90000 })))).toEqual([45000, 45000])
  })

  it('caps the cumulative components at the subtotal (the manual one is trimmed first)', () => {
    const cart = [line('a', 10000)]
    const p = promo('p1', 'fixed', { value: 8000 })
    const comps = discountComponents(base({ cart, appliedPromotions: [p], discountType: 'fixed', discountRunning: 5000 }))
    expect(comps.map((c) => c.amount)).toEqual([8000, 2000])
  })

  it('is null for a fractional total or a free sale that still has a positive total', () => {
    expect(withSaleLineData(base({ cart: [line('a', 1000)], total: 1000.5 }))).toBeNull()
    expect(withSaleLineData(base({ cart: [line('a', 0)], total: 500 }))).toBeNull()
  })

  it('keeps a Rp0 reward line at 0', () => {
    const cart = [line('a', 100000), line('r', 0, 1, { isReward: true, rewardConditionId: 'c1' })]
    expect(nets(withSaleLineData(base({ cart, total: 111000 })))).toEqual([111000, 0])
  })
})

describe('refundGroups (all-or-nothing promo groups)', () => {
  const bundle = promo('b1', 'bundle', { bundleConfig: { slots: [{ productKeys: ['a'], quantity: 1 }, { productKeys: ['b'], quantity: 1 }], bundlePrice: 150000 } })
  const bxgy = promo('x1', 'buy_x_get_y', { bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['g'], getDiscountKind: 'percentage', getDiscountValue: 100 } })
  const byId = (...ps: Promotion[]) => (id: string) => ps.find((p) => p.id === id)

  it('puts a bundle reward line and its paid slot lines in one group; others stay free', () => {
    const cart = [line('a', 100000), line('b', 0, 1, { isReward: true, rewardPromotionId: 'b1' }), line('z', 5000)]
    expect(refundGroups(cart, byId(bundle))).toEqual(['bundle:b1:1', 'bundle:b1:1', null])
  })

  it('groups a separate-set BXGY reward with its buy lines', () => {
    const cart = [line('a', 100000), line('g', 0, 1, { isReward: true, rewardPromotionId: 'x1' }), line('z', 5000)]
    expect(refundGroups(cart, byId(bxgy))).toEqual(['bxgy:x1:1', 'bxgy:x1:1', null])
  })

  it('merges groups that share a paid line under the smallest key', () => {
    const cart = [
      line('a', 100000),
      line('b', 0, 1, { isReward: true, rewardPromotionId: 'b1' }),
      line('g', 0, 1, { isReward: true, rewardPromotionId: 'x1' }),
    ]
    expect(refundGroups(cart, byId(bundle, bxgy))).toEqual(['bundle:b1:1', 'bundle:b1:1', 'bundle:b1:1'])
  })

  it('a loyalty reward line has no group and a missing promotion config yields no group', () => {
    const cart = [line('a', 100000), line('r', 0, 1, { isReward: true, rewardConditionId: 'c1' }), line('b', 0, 1, { isReward: true, rewardPromotionId: 'gone' })]
    expect(refundGroups(cart, byId(bundle))).toEqual([null, null, null])
  })

  it('withSaleLineData carries the group onto the payload lines', () => {
    const cart = [line('a', 100000), line('b', 0, 1, { isReward: true, rewardPromotionId: 'b1' })]
    const r = withSaleLineData(base({ cart, appliedPromotions: [bundle], total: 111000 }))
    expect(r!.map((l) => l.refundGroup)).toEqual(['bundle:b1:1', 'bundle:b1:1'])
    expect(nets(r)).toEqual([111000, 0])
  })
})

// Mirrors of backend/internal/service/allocate_test.go TestAllocateFromPricingScenarios / TestDiscountComponentsTrackEngine:
// the same carts must give the same per-line nets on both sides.
describe('parity with the Go allocator scenarios', () => {
  const sized = (productId: string, variantSize: string, price: number, quantity: number): CartItem =>
    ({ productId, productName: productId, variantSize, price, quantity, subtotal: price * quantity }) as CartItem
  const three = [sized('a', '50ml', 100000, 1), sized('b', '50ml', 50000, 2), sized('c', '10ml', 80000, 1)]

  it('a scoped percentage promo hits only its product', () => {
    const p = promo('p', 'percentage', { value: 10, applicableProductIds: ['a'] })
    expect(nets(withSaleLineData(base({ cart: three, appliedPromotions: [p], total: 270000 })))).toEqual([90000, 100000, 80000])
  })

  it('a tiered promo spreads over every line', () => {
    const p = promo('t', 'tiered', { tieredConfig: { tiers: [{ minSubtotal: 200000, kind: 'percentage', value: 10 }] } })
    expect(nets(withSaleLineData(base({ cart: three, appliedPromotions: [p], total: 252000 })))).toEqual([90000, 90000, 72000])
  })

  it('BXGY same-set discounts the counted buy-set lines only', () => {
    const cart = [sized('a', '', 100000, 1), sized('b', '', 50000, 1), sized('z', '', 70000, 1)]
    const p = promo('x', 'buy_x_get_y', { bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a', 'b'], getDiscountKind: 'percentage', getDiscountValue: 100 } })
    const r = withSaleLineData(base({ cart, appliedPromotions: [p], total: 170000 }))
    expect(r![2].netAmount).toBe(70000)
    expect(r!.reduce((s, l) => s + (l.netAmount ?? 0), 0)).toBe(170000)
  })

  it('a separate-set BXGY contributes no discount component (its saving is the reward line price)', () => {
    const p = promo('xs', 'buy_x_get_y', { bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b'], getDiscountKind: 'percentage', getDiscountValue: 100 } })
    expect(discountComponents(base({ cart: three, appliedPromotions: [p] }))).toEqual([])
  })

  it('a scoped BOGO discounts its cheapest unit across its product lines', () => {
    const p = promo('bg', 'bogo', { applicableProductIds: ['b'] })
    const comps = discountComponents(base({ cart: three, appliedPromotions: [p] }))
    expect(comps).toEqual([{ amount: 50000, eligible: [1] }])
  })

  it('manual plus promo is capped at the subtotal and the line stays at 0', () => {
    const cart = [sized('a', '', 10000, 1)]
    const p = promo('f', 'fixed', { value: 50000 })
    expect(nets(withSaleLineData(base({ cart, appliedPromotions: [p], discountType: 'fixed', discountRunning: 50000, total: 0 })))).toEqual([0])
  })

  it('component amounts sum to the engine discount (stacked, uncapped)', () => {
    const p1 = promo('p1', 'fixed', { value: 20000, applicableProductIds: ['a'] })
    const t = promo('t', 'tiered', { tieredConfig: { tiers: [{ minSubtotal: 100000, kind: 'percentage', value: 5 }] } })
    const cart = [sized('a', '50ml', 100000, 2), sized('b', '50ml', 60000, 1), sized('c', '10ml', 45000, 3)]
    const comps = discountComponents(base({ cart, appliedPromotions: [t, p1], discountType: 'percentage', discountRunning: 5 }))
    expect(comps.map((c) => c.amount)).toEqual([19750, 20000, 19750])
    expect(comps.map((c) => c.eligible)).toEqual([null, [0], null])
  })
})

describe('withSaleLineData never fails the sale', () => {
  it('returns null (whole-order refund only) instead of throwing on a malformed promotion config', () => {
    const bad = promo('b1', 'bundle', { bundleConfig: { slots: [{ quantity: 1 } as never], bundlePrice: 1 } })
    const cart = [line('a', 1000), line('b', 0, 1, { isReward: true, rewardPromotionId: 'b1' })]
    expect(() => withSaleLineData(base({ cart, appliedPromotions: [bad], total: 1000 }))).not.toThrow()
    expect(withSaleLineData(base({ cart, appliedPromotions: [bad], total: 1000 }))).toBeNull()
  })
})

describe('withSaleLineData reports instead of swallowing', () => {
  it('hands the error to onError and still returns null', () => {
    const bad = promo('b1', 'bundle', { bundleConfig: { slots: [{ quantity: 1 } as never], bundlePrice: 1 } })
    const cart = [line('a', 1000), line('b', 0, 1, { isReward: true, rewardPromotionId: 'b1' })]
    const seen: unknown[] = []
    expect(withSaleLineData(base({ cart, appliedPromotions: [bad], total: 1000, onError: (e) => seen.push(e) }))).toBeNull()
    expect(seen).toHaveLength(1)
  })
})
