import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { promoProductIds } from './promoProducts'

type Promotion = components['schemas']['Promotion']
const base = { id: 'x', name: 'P', value: 10, isActive: true } as const
const promo = (o: Partial<Promotion>): Promotion => ({ ...base, type: 'percentage', ...o }) as Promotion
// Wed 2026-11-04 10:00 WIB
const ctx = { now: new Date('2026-11-04T03:00:00Z'), outletId: 'o1', timezone: 'Asia/Jakarta' }

describe('promoProductIds', () => {
  it('lists the products an active percentage promo targets', () => {
    expect([...promoProductIds([promo({ applicableProductIds: ['a', 'b'] })], ctx)].sort()).toEqual(['a', 'b'])
  })
  it('a storewide promo (no product scope) marks nothing', () => {
    expect(promoProductIds([promo({}), promo({ applicableProductIds: [] })], ctx).size).toBe(0)
  })
  it('skips inactive and code-only promos', () => {
    const ps = [promo({ applicableProductIds: ['a'], isActive: false }), promo({ applicableProductIds: ['b'], codeOnly: true })]
    expect(promoProductIds(ps, ctx).size).toBe(0)
  })
  it('skips promos outside their dates, weekday, hours or outlet', () => {
    const ps = [
      promo({ applicableProductIds: ['a'], endDate: '2026-11-03' }),
      promo({ applicableProductIds: ['b'], startDate: '2026-11-05' }),
      promo({ applicableProductIds: ['c'], activeDays: [1] }),
      promo({ applicableProductIds: ['d'], activeFromHour: '12:00', activeToHour: '14:00' }),
      promo({ applicableProductIds: ['e'], outletIds: ['o2'] }),
    ]
    expect(promoProductIds(ps, ctx).size).toBe(0)
  })
  it('keeps a promo that is inside its window and outlet', () => {
    const ps = [promo({ applicableProductIds: ['a'], activeDays: [3], activeFromHour: '09:00', activeToHour: '11:00', outletIds: ['o1'] })]
    expect([...promoProductIds(ps, ctx)]).toEqual(['a'])
  })
  it('ignores minPurchase (cart-dependent)', () => {
    expect([...promoProductIds([promo({ applicableProductIds: ['a'], minPurchase: 999_999_999 })], ctx)]).toEqual(['a'])
  })
  it('buy_x_get_y marks buy and get products by product id (variant keys strip the size)', () => {
    const p = promo({ type: 'buy_x_get_y', bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a|50 ml'], getProductIds: ['b'], getDiscountKind: 'percentage', getDiscountValue: 100 } })
    expect([...promoProductIds([p], ctx)].sort()).toEqual(['a', 'b'])
  })
  it('same-set buy_x_get_y with no keys is storewide', () => {
    const p = promo({ type: 'buy_x_get_y', bxgyConfig: { buyQuantity: 2, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 } })
    expect(promoProductIds([p], ctx).size).toBe(0)
  })
  it('bundle marks every slot alternative', () => {
    const p = promo({ type: 'bundle', bundleConfig: { bundlePrice: 1, slots: [{ productKeys: ['a', 'b|30 ml'], quantity: 1 }, { productKeys: ['c'], quantity: 1 }] } })
    expect([...promoProductIds([p], ctx)].sort()).toEqual(['a', 'b', 'c'])
  })
  it('skips a bundle whose slots overlap (the engine ignores it)', () => {
    const p = promo({ type: 'bundle', bundleConfig: { bundlePrice: 1, slots: [{ productKeys: ['a'], quantity: 1 }, { productKeys: ['a|M'], quantity: 1 }] } })
    expect(promoProductIds([p], ctx).size).toBe(0)
  })
  it('tiered is storewide', () => {
    expect(promoProductIds([promo({ type: 'tiered', tieredConfig: { tiers: [{ minSubtotal: 1, kind: 'fixed', value: 1 }] }, applicableProductIds: ['a'] })], ctx).size).toBe(0)
  })
})
