import { readFileSync } from 'node:fs'
import { SyncEngine, type KV, type OutboxItem } from '@mandalika/sync'
import { buildPromotionMetadata } from './promotionMetadata'
import { computePricing, type PricingInput } from './pricing'
import { afterEach, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { cashierReducer, CASHIER_INITIAL_STATE } from './state/cashierReducer'
import { planPromotionFulfillment, type PromotionOwner } from './promotionFulfillment'

type Promotion = components['schemas']['Promotion']
const cart = [{ productId: 'P', productName: 'P', variantSize: 'M', price: 100, quantity: 1, subtotal: 100 },
  { productId: 'Q', productName: 'Q', variantSize: 'M', price: 20, quantity: 1, subtotal: 20 }]
const products: components['schemas']['Product'][] = [{ id: 'P', name: 'P', brand: '', categoryId: '', isActive: true, isFeatured: false, isFavourite: false, createdAt: '', variants: [{ size: 'M', price: 100, stock: 10, sku: 'P-M' }] }]
it.each(['bundle', 'buy_x_get_y'] as const)('legacy overlapping %s installs no owner or physical effect', type => {
  const p: Promotion = { id: 'promo', name: 'legacy', type, value: 0, isActive: true, createdAt: '', combinable: true,
    bundleConfig: { bundlePrice: 50, slots: [{ productKeys: ['P'], quantity: 1 }, { productKeys: ['P|M', 'Q'], quantity: 1 }] },
    bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['P'], getProductIds: ['P|M'], getDiscountKind: 'percentage', getDiscountValue: 100 } }
  const s = { ...CASHIER_INITIAL_STATE, cart }
  const owners: PromotionOwner[] = [{ kind: 'direct', promotion: p }, { kind: 'code', code: { code: 'Raw', type, value: 0, combinable: true, promotion: { ...p, isBOGO: false } } }]
  for (const owner of owners) {
    expect(planPromotionFulfillment(s, owner, products)).toEqual({ kind: 'none' })
    expect(cashierReducer(s, { type: 'APPLY_FULFILLMENT', owner, products })).toBe(s)
  }
})

const vectors: { name: string; left: string[]; right: string[]; overlap: boolean }[] = JSON.parse(readFileSync(new URL('../../../../backend/internal/promotionkeys/testdata/overlap.json', import.meta.url), 'utf8'))
it.each(vectors.filter(v => v.overlap))('$name blocks both physical types and direct/code owner actions', v => {
  for (const type of ['bundle', 'buy_x_get_y'] as const) {
    const p: Promotion = { id: 'P-id', name: 'legacy', type, value: 0, combinable: true, isActive: true, createdAt: '',
      bundleConfig: { slots: [{ productKeys: v.left, quantity: 1 }, { productKeys: v.right, quantity: 1 }], bundlePrice: 50 },
      bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: v.left, getProductIds: v.right, getDiscountKind: 'percentage', getDiscountValue: 100 } }
    const s = { ...CASHIER_INITIAL_STATE, cart }, c = { code: 'Original-Raw', type, value: 0, combinable: true, promotion: { ...p, isBOGO: false } }
    for (const owner of [{ kind: 'direct', promotion: p }, { kind: 'code', code: c }] as PromotionOwner[]) {
      expect(planPromotionFulfillment(s, owner, products)).toEqual({ kind: 'none' })
      expect(cashierReducer(s, { type: 'APPLY_FULFILLMENT', owner, products })).toBe(s)
    }
    expect(cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: p })).toBe(s)
    expect(cashierReducer(s, { type: 'APPLY_PROMO_CODE', code: c, combinable: true })).toBe(s)
    expect(cashierReducer(s, { type: 'APPLY_BUNDLE', promotion: p, freed: [], applications: 1 })).toBe(s)
    expect(s.cart).toEqual(cart)
    expect(s.appliedPromoCodes).toEqual([])
    expect(s.appliedPromotions).toEqual([])
  }
})
it.each(['bundle', 'buy_x_get_y'] as const)('distinct variants of same product remain valid %s with code provenance', type => {
  const catalog = [{ ...products[0], variants: [...products[0].variants, { size: 'L', price: 20, stock: 10, sku: 'P-L' }] }]
  const p: Promotion = { id: 'P-id', name: 'valid', type, value: 0, combinable: true, isActive: true, createdAt: '',
    bundleConfig: { slots: [{ productKeys: ['P|M'], quantity: 1 }, { productKeys: ['P|L'], quantity: 1 }], bundlePrice: 105 },
    bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['P|M'], getProductIds: ['P|L'], getDiscountKind: 'percentage', getDiscountValue: 50 } }
  const start = { ...CASHIER_INITIAL_STATE, cart: type === 'bundle' ? [cart[0], { ...cart[1], productId: 'P', variantSize: 'L' }] : [cart[0]] }
  const d = cashierReducer(start, { type: 'APPLY_FULFILLMENT', owner: { kind: 'direct', promotion: p }, products: catalog })
  const c = cashierReducer(start, { type: 'APPLY_FULFILLMENT', owner: { kind: 'code', code: { code: 'Raw-P', type, value: 0, combinable: true, promotion: { ...p, isBOGO: false } } }, products: catalog })
  expect(c.cart).toEqual(d.cart)
  expect(c.cart.reduce((n, item) => n + item.quantity, 0)).toBe(2)
  expect(c.cart.find(item => item.isReward)).toMatchObject({ productId: 'P', variantSize: 'L', price: type === 'bundle' ? 5 : 10, rewardPromotionId: p.id })
  const derived = computePricing({ cart: c.cart, appliedPromotions: c.appliedPromotions, appliedPromoCodes: c.appliedPromoCodes, discountType: 'fixed', surchargeType: 'fixed', discountRunning: 0, surchargeRunning: 0, settings: { taxEnabled: false, roundingEnabled: false } as PricingInput['settings'], loyalty: { enabled: false, pointsPerThousand: 0 } as PricingInput['loyalty'], hasCustomer: false, pointsRedeemed: 0, customerPoints: 0 })
  expect(buildPromotionMetadata(c, derived)).toMatchObject({ promotionIds: [], discountCodes: ['Raw-P'] })
  expect(cashierReducer(c, { type: 'REMOVE_PROMO_CODE', code: 'Raw-P' }).cart).toEqual(start.cart)
})
afterEach(() => vi.unstubAllGlobals())
it('stored legacy physical sale retains original evidence when reconstructed after validation changes', () => {
  vi.stubGlobal('navigator', { onLine: false })
  const values = new Map<string, string>(), kv: KV = { get: k => values.get(k) ?? null, set: (k,v) => { values.set(k,v) }, remove: k => { values.delete(k) }, setDurable: async (k,v) => { values.set(k,v) }, removeDurable: async k => { values.delete(k) } }
  const old: OutboxItem = { type: 'order', idempotencyKey: 'original-overlap-key', seq: 1, attempts: 5, status: 'failed', clientCreatedAt: '2026-08-01T01:00:00Z', lastError: 'Original capture evidence', payload: { promotionIds: ['legacy'], discountCodes: ['Raw'], items: [{ ...cart[0], isReward: true, rewardPromotionId: 'legacy', price: 7, subtotal: 7 }] } }
  const bytes = JSON.stringify(old); kv.set('mandalika.pos.outbox', JSON.stringify([old]))
  const engine = new SyncEngine({ async request() { throw new Error('No network') } }, {}, kv)
  expect(JSON.stringify(engine.outbox.deadLettered()[0])).toBe(bytes)
  expect(engine.outbox.deadLettered()).toHaveLength(1)
  expect(engine.pendingCount()).toBe(0) // Parked, not eligible for automatic flush.
})
