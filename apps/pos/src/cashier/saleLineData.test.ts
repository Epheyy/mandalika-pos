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
