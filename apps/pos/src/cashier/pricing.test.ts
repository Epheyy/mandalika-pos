import { describe, it, test, expect } from 'vitest'
import {
  computePricing,
  calcPromoDiscount,
  bxgyRewardOptions,
  bundleApplications,
  bundleAllocate,
  type PricingInput,
} from './pricing'
import type { components } from '@mandalika/api'

type CartItem = components['schemas']['CartItem']
type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']
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
  it('separate-set buy_x_get_y contributes 0 promo discount (reward is a priced line)', () => {
    const cfg: BXGYConfig = { buyQuantity: 2, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b'], getDiscountKind: 'percentage', getDiscountValue: 100 }
    const items = [ci('a', 'M', 10000, 2), ci('b', 'M', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), items, sub(items))).toBe(0)
  })
  it('same-set buy_x_get_y still discounts in place', () => {
    const items = [ci('a', 'M', 10000, 3)]
    expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 }), items, sub(items))).toBe(10000)
  })
  it('same-set buy2get1 free → cheapest unit free', () => {
    const items = [ci('a', 'M', 10000, 3)]
    expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 }), items, sub(items))).toBe(10000)
  })
  it('repeats and respects maxApplications cap', () => {
    const items = [ci('a', 'M', 10000, 6)]
    expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 }), items, sub(items))).toBe(20000)
    expect(calcPromoDiscount(bxgy({ buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100, maxApplications: 1 }), items, sub(items))).toBe(10000)
  })
  it('separate-set always returns 0 from calcPromoDiscount (reward is a priced line)', () => {
    const cfg: BXGYConfig = { buyQuantity: 2, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b'], getDiscountKind: 'percentage', getDiscountValue: 50 }
    const items = [ci('a', 'M', 10000, 2), ci('b', 'M', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), items, sub(items))).toBe(0)
    const items0 = [ci('a', 'M', 10000, 1), ci('b', 'M', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), items0, sub(items0))).toBe(0)
  })
  it('fixed get discount capped at unit price', () => {
    const items = [ci('a', 'M', 5000, 2)]
    expect(calcPromoDiscount(bxgy({ buyQuantity: 1, getQuantity: 1, getDiscountKind: 'fixed', getDiscountValue: 99999 }), items, sub(items))).toBe(5000)
  })
  it('variant-level separate-set: both wrong and right variant return 0 (reward is a priced line)', () => {
    const cfg: BXGYConfig = { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b|10ml'], getDiscountKind: 'percentage', getDiscountValue: 100 }
    const wrong = [ci('a', 'M', 10000, 1), ci('b', '50ml', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), wrong, sub(wrong))).toBe(0)
    const right = [ci('a', 'M', 10000, 1), ci('b', '10ml', 8000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), right, sub(right))).toBe(0)
  })
  it('missing bxgyConfig → 0', () => {
    const items = [ci('a', 'M', 10000, 3)]
    const promo: Promotion = { id: 'p1', name: 'x', type: 'buy_x_get_y', value: 0, isActive: true, createdAt: '' }
    expect(calcPromoDiscount(promo, items, sub(items))).toBe(0)
  })
  it('separate-set: all cases return 0 from calcPromoDiscount (reward is a priced line)', () => {
    // Mirrors the on-device report: buy 2 Gorgeous, get 1 Holy Sweet 10ml free.
    const cfg: BXGYConfig = {
      buyQuantity: 2, getQuantity: 1, buyProductIds: ['gorgeous'],
      getProductIds: ['holysweet|10ml ATOMIZER'], getDiscountKind: 'percentage', getDiscountValue: 100,
    }
    const unrelated = [ci('random', 'M', 50000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), unrelated, sub(unrelated))).toBe(0)
    const buyOnly = [ci('gorgeous', 'M', 100000, 2)]
    expect(calcPromoDiscount(bxgy(cfg), buyOnly, sub(buyOnly))).toBe(0)
    // even when qualified, separate-set contributes 0 here — saving lives in the reward line
    const met = [ci('gorgeous', 'M', 100000, 2), ci('holysweet', '10ml ATOMIZER', 75000, 1)]
    expect(calcPromoDiscount(bxgy(cfg), met, sub(met))).toBe(0)
  })
})

describe('bxgyRewardOptions (separate-set reward resolution)', () => {
  const prod = (id: string, name: string, variants: { size: string; price: number }[]): Product =>
    ({
      id,
      name,
      brand: 'B',
      categoryId: 'c',
      variants: variants.map((v) => ({ size: v.size, price: v.price, stock: 5, sku: '', barcode: '' })) as any,
      isFeatured: false,
      isFavourite: false,
      isActive: true,
      createdAt: '',
    }) as Product
  const catalog: Product[] = [
    prod('b', 'Holy Sweet', [
      { size: '10ml', price: 8000 },
      { size: '50ml', price: 30000 },
    ]),
    prod('c', 'Other', [{ size: 'M', price: 12000 }]),
  ]

  it('a whole-product (pid) entry expands to ALL its variants at net', () => {
    const cfg: BXGYConfig = {
      buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b'],
      getDiscountKind: 'percentage', getDiscountValue: 100,
    }
    const opts = bxgyRewardOptions(cfg, catalog)
    // both variants of b, none of c
    expect(opts.map((o) => `${o.productId}|${o.variantSize}`)).toEqual(['b|10ml', 'b|50ml'])
    // free → net 0 for each
    expect(opts.every((o) => o.net === 0)).toBe(true)
    expect(opts[0].fullPrice).toBe(8000)
  })

  it('a variant-level (pid|size) entry yields exactly that one variant', () => {
    const cfg: BXGYConfig = {
      buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b|10ml'],
      getDiscountKind: 'percentage', getDiscountValue: 100,
    }
    const opts = bxgyRewardOptions(cfg, catalog)
    expect(opts).toHaveLength(1)
    expect(opts[0].productId).toBe('b')
    expect(opts[0].variantSize).toBe('10ml')
    expect(opts[0].net).toBe(0)
  })

  it('percentage<100 net is fullPrice minus the rounded discount', () => {
    const cfg: BXGYConfig = {
      buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b|50ml'],
      getDiscountKind: 'percentage', getDiscountValue: 25,
    }
    const opts = bxgyRewardOptions(cfg, catalog)
    expect(opts).toHaveLength(1)
    // 30000 - round(30000 * 0.25) = 30000 - 7500 = 22500
    expect(opts[0].net).toBe(22500)
    expect(opts[0].fullPrice).toBe(30000)
  })

  it('fixed get discount nets fullPrice minus value (floored at 0)', () => {
    const cfg: BXGYConfig = {
      buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['b|10ml'],
      getDiscountKind: 'fixed', getDiscountValue: 3000,
    }
    const opts = bxgyRewardOptions(cfg, catalog)
    // 8000 - 3000 = 5000
    expect(opts[0].net).toBe(5000)
  })

  it('empty getProductIds → no options', () => {
    const cfg: BXGYConfig = {
      buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: [],
      getDiscountKind: 'percentage', getDiscountValue: 100,
    }
    expect(bxgyRewardOptions(cfg, catalog)).toEqual([])
  })
})

describe('calcPromoDiscount tiered (parity with Go calcPromotionDiscount)', () => {
  type TieredConfig = NonNullable<Promotion['tieredConfig']>
  const tieredPromo = (cfg: TieredConfig): Promotion => ({
    id: 'p-tiered', name: 'Tiered', type: 'tiered', value: 0, isActive: true, createdAt: '', tieredConfig: cfg,
  })
  const twotier: TieredConfig = {
    tiers: [
      { minSubtotal: 100000, kind: 'fixed', value: 10000 },
      { minSubtotal: 200000, kind: 'percentage', value: 15 },
    ],
  }

  it('tier2 (300k subtotal, 15% percentage) → 45000', () => {
    const items = [ci('a', '', 300000, 1)]
    expect(calcPromoDiscount(tieredPromo(twotier), items, 300000)).toBe(45000)
  })

  it('tier1 (120k subtotal, fixed 10000) → 10000', () => {
    const items = [ci('a', '', 120000, 1)]
    expect(calcPromoDiscount(tieredPromo(twotier), items, 120000)).toBe(10000)
  })

  it('below lowest tier (50k) → 0', () => {
    const items = [ci('a', '', 50000, 1)]
    expect(calcPromoDiscount(tieredPromo(twotier), items, 50000)).toBe(0)
  })

  it('fixed tier capped at sub if value > sub', () => {
    const cfg: TieredConfig = { tiers: [{ minSubtotal: 0, kind: 'fixed', value: 999999 }] }
    expect(calcPromoDiscount(tieredPromo(cfg), [ci('a', '', 5000, 1)], 5000)).toBe(5000)
  })

  it('null tieredConfig → 0', () => {
    const promo: Promotion = { id: 'p2', name: 'T', type: 'tiered', value: 0, isActive: true, createdAt: '' }
    expect(calcPromoDiscount(promo, [ci('a', '', 300000, 1)], 300000)).toBe(0)
  })
})

import { pickTier, tieredNextTier } from './pricing'

describe('pickTier', () => {
  type TieredConfig = NonNullable<Promotion['tieredConfig']>
  const cfg: TieredConfig = {
    tiers: [
      { minSubtotal: 100000, kind: 'fixed', value: 10000 },
      { minSubtotal: 200000, kind: 'percentage', value: 15 },
    ],
  }

  it('picks tier2 at 300k', () => {
    const t = pickTier(cfg, 300000)
    expect(t?.minSubtotal).toBe(200000)
    expect(t?.kind).toBe('percentage')
  })

  it('picks tier1 at 120k', () => {
    const t = pickTier(cfg, 120000)
    expect(t?.minSubtotal).toBe(100000)
    expect(t?.kind).toBe('fixed')
  })

  it('returns null below lowest tier', () => {
    expect(pickTier(cfg, 50000)).toBeNull()
  })

  it('null cfg → null', () => {
    expect(pickTier(null, 100000)).toBeNull()
  })
})

describe('tieredNextTier', () => {
  type TieredConfig = NonNullable<Promotion['tieredConfig']>
  const twotier: TieredConfig = {
    tiers: [
      { minSubtotal: 100000, kind: 'fixed', value: 10000 },
      { minSubtotal: 200000, kind: 'percentage', value: 15 },
    ],
  }
  const threetier: TieredConfig = {
    tiers: [
      { minSubtotal: 100000, kind: 'fixed', value: 10000 },
      { minSubtotal: 200000, kind: 'percentage', value: 15 },
      { minSubtotal: 500000, kind: 'percentage', value: 25 },
    ],
  }

  it('at 50k → first tier (100k), gap=50000', () => {
    const n = tieredNextTier(twotier, 50000)
    expect(n).not.toBeNull()
    expect(n?.minSubtotal).toBe(100000)
    expect(n?.gap).toBe(50000)
  })

  it('at 120k → tier2 (200k), gap=80000', () => {
    const n = tieredNextTier(twotier, 120000)
    expect(n).not.toBeNull()
    expect(n?.minSubtotal).toBe(200000)
    expect(n?.gap).toBe(80000)
  })

  it('at top tier (300k in 2-tier) → null', () => {
    expect(tieredNextTier(twotier, 300000)).toBeNull()
  })

  it('at 300k in 3-tier cfg → next=500k tier, gap=200000', () => {
    const n = tieredNextTier(threetier, 300000)
    expect(n).not.toBeNull()
    expect(n?.minSubtotal).toBe(500000)
    expect(n?.gap).toBe(200000)
  })

  it('null cfg → null', () => {
    expect(tieredNextTier(null, 100000)).toBeNull()
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

describe('bundle primitives (parity with Go bundleApplications/bundleAllocate)', () => {
  const slots = (): NonNullable<Promotion['bundleConfig']>['slots'] => [
    { productKeys: ['p110'], quantity: 1 },
    { productKeys: ['atomA', 'atomB'], quantity: 1 },
    { productKeys: ['p2ml'], quantity: 1 },
  ]
  const item = (productId: string, quantity: number) =>
    ({ productId, variantSize: '', price: 0, quantity, subtotal: 0, productName: '' }) as CartItem

  test('bundleApplications counts complete sets, capped', () => {
    const cfg = { slots: slots(), bundlePrice: 575000, maxApplications: 0 }
    expect(bundleApplications(cfg, [item('p110', 1), item('atomA', 1), item('p2ml', 1)])).toBe(1)
    expect(
      bundleApplications(cfg, [item('p110', 2), item('atomA', 1), item('atomB', 1), item('p2ml', 2)]),
    ).toBe(2)
    expect(bundleApplications(cfg, [item('p110', 1), item('atomA', 1)])).toBe(0)
    expect(
      bundleApplications({ ...cfg, maxApplications: 1 }, [
        item('p110', 2),
        item('atomA', 1),
        item('atomB', 1),
        item('p2ml', 2),
      ]),
    ).toBe(1)
    expect(bundleApplications(null, [item('p110', 1)])).toBe(0)
  })

  test('bundleAllocate zeros cheapest-first, keeps anchor', () => {
    expect(bundleAllocate([575000, 225000, 1], 575000, 1)).toEqual([575000, 0, 0])
    expect(bundleAllocate([575000, 225000, 1], 500000, 1)).toEqual([500000, 0, 0])
    expect(bundleAllocate([100, 50], 200, 1)).toEqual([100, 50])
  })

  test('calcPromoDiscount is 0 for a bundle promo', () => {
    const promo = {
      type: 'bundle',
      bundleConfig: { slots: slots(), bundlePrice: 100, maxApplications: 0 },
    } as Promotion
    expect(calcPromoDiscount(promo, [item('p110', 1)], 200)).toBe(0)
  })
})

describe('C1 discountParts / roundingAmount feed a slip that adds up', () => {
  const promo = (id: string, name: string, value: number): Promotion => ({ id, name, type: 'percentage', value, isActive: true, createdAt: '' })
  const settingsOn = { taxEnabled: true, taxRate: 10, roundingEnabled: true, roundingType: 'nearest_500' } as PricingInput['settings']

  it('names every deduction and the parts sum to discountAmount, then slip == total', () => {
    const input: PricingInput = {
      ...base, appliedPromotions: [promo('a', 'Promo A', 10), promo('b', 'Promo B', 5)],
      appliedPromoCodes: [{ code: 'HEMAT', value: 2000, type: 'fixed' }],
      discountRunning: 3000, settings: settingsOn, surchargeRunning: 1234, surchargeType: 'fixed',
      loyalty: { enabled: true, pointsPerThousand: 1, redemptionRate: 100 } as PricingInput['loyalty'],
      hasCustomer: true, pointsRedeemed: 30, customerPoints: 100,
    }
    const p = computePricing(input)
    expect(p.discountParts.map((d) => d.label)).toEqual(['Promo A', 'Promo B', 'Kode HEMAT', 'Diskon manual'])
    expect(p.discountParts.reduce((s, d) => s + d.amount, 0)).toBe(p.discountAmount)
    const beforeRounding = p.subtotal - p.discountAmount + p.taxAmount + p.surchargeAmount
    expect(beforeRounding + p.roundingAmount - p.redeemAmount).toBe(p.total)
  })

  it('clamps rows when the discount is capped at the subtotal', () => {
    const p = computePricing({
      ...base, appliedPromotions: [promo('a', 'Promo A', 80), promo('b', 'Promo B', 80)], appliedPromoCodes: [], discountRunning: 5000,
    })
    expect(p.discountAmount).toBe(100000)
    expect(p.discountParts.reduce((s, d) => s + d.amount, 0)).toBe(100000)
    expect(p.discountParts).toEqual([{ label: 'Promo A', amount: 80000 }, { label: 'Promo B', amount: 20000 }])
  })
})

describe('P-17 displayed savings never exceed the applied discount', () => {
  const code150 = { code: 'X150', value: 150, type: 'percentage' } as any

  it('a 150% code on Rp 100.000: promo component is clamped to the applied total', () => {
    const res = computePricing({ ...base, appliedPromotions: [], appliedPromoCodes: [code150] })
    expect(res.discountAmount).toBe(100000)
    expect(res.appliedPromoDiscountAmount).toBe(100000) // not 150000
    expect(res.total).toBe(0)
  })

  it('promo + code + manual components sum to the applied discount', () => {
    const promo = { id: 'a', name: 'A', type: 'percentage', value: 60, combinable: true } as any
    const res = computePricing({
      ...base, appliedPromotions: [promo], appliedPromoCodes: [{ code: 'Y', value: 70000, type: 'fixed' }],
      discountType: 'fixed', discountRunning: 30000,
    })
    expect(res.discountAmount).toBe(100000)
    expect(res.appliedPromoDiscountAmount + (res.discountAmount - res.appliedPromoDiscountAmount)).toBe(100000)
    expect(res.appliedPromoDiscountAmount).toBeLessThanOrEqual(res.discountAmount)
    expect(res.discountParts.reduce((s, d) => s + d.amount, 0)).toBe(res.discountAmount)
  })

  it('does not change the order total the server receives (already clamped)', () => {
    const res = computePricing({ ...base, appliedPromotions: [], appliedPromoCodes: [code150] })
    expect(res.taxableAmount).toBe(0)
    expect(res.total).toBe(0)
    expect(res.discountAmount).toBe(res.subtotal)
  })
})

describe('P-17 manual discount shows the applied amount', () => {
  it('Rp 200.000 manual on a Rp 100.000 cart applies Rp 100.000; components sum to the total', () => {
    const res = computePricing({ ...base, appliedPromotions: [], appliedPromoCodes: [], discountType: 'fixed', discountRunning: 200000 })
    expect(res.appliedManualDiscountAmount).toBe(100000)
    expect(res.appliedPromoDiscountAmount + res.appliedManualDiscountAmount).toBe(res.discountAmount)
  })
  it('promo takes the cap first, manual shows only what is left (0 here)', () => {
    const res = computePricing({ ...base, appliedPromotions: [], appliedPromoCodes: [{ code: 'X150', value: 150, type: 'percentage' } as any], discountType: 'fixed', discountRunning: 30000 })
    expect(res.appliedPromoDiscountAmount).toBe(100000)
    expect(res.appliedManualDiscountAmount).toBe(0)
    expect(res.appliedPromoDiscountAmount + res.appliedManualDiscountAmount).toBe(res.discountAmount)
  })
})
