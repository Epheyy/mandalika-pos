import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { computePricing, linkedPromoShape, type PricingInput } from './pricing'
import { decideApplyCode, type PromoEvalContext, type AppliedPromoCode } from './promoValidate'
import { cashierReducer, CASHIER_INITIAL_STATE } from './state/cashierReducer'

type Promotion = components['schemas']['Promotion']
type Code = components['schemas']['DiscountCode']
type Golden = { name: string; subtotal: number; config?: Promotion['tieredConfig']; discount: number; total: number }
const golden: Golden[] = JSON.parse(readFileSync(new URL('../../../../backend/internal/service/testdata/linked_tier_golden.json', import.meta.url), 'utf8'))
const ctx: PromoEvalContext = { now: new Date('2026-09-20T05:00:00Z'), outletId: 'outlet', subtotal: 100000, hasCustomer: true, customerId: 'Raw-Customer' }
const code: Code = { id: 'c', code: 'MiXeD-Code', type: 'fixed', value: 987, promotionId: 'tier', customerId: 'Raw-Customer', usageCount: 0, isActive: true, createdAt: '' }
const promo = (config?: Promotion['tieredConfig']): Promotion => ({ id: 'tier', name: 'Tier', type: 'tiered', value: 95, isActive: true, createdAt: '', combinable: true, tieredConfig: config })
function select(p: Promotion, subtotal = 100000, c = code): AppliedPromoCode {
  const result = decideApplyCode('mixed-code', [c], { ...ctx, subtotal }, [p])
  if (!result.ok) throw new Error(result.reason)
  return result.code
}
function input(subtotal: number): PricingInput {
  return { cart: [{ productId: 'p', productName: 'P', variantSize: '120ml', price: subtotal, quantity: 1, subtotal }], discountType: 'fixed', surchargeType: 'fixed', discountRunning: 0, surchargeRunning: 0,
    appliedPromotions: [], appliedPromoCodes: [], settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as PricingInput['settings'],
    loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as PricingInput['loyalty'], hasCustomer: true, pointsRedeemed: 0, customerPoints: 0 }
}

it('LP01 real selection gives the same Rp90000 as direct promotion', () => {
  const p = promo(golden[0].config), selected = select(p)
  const direct = computePricing({ ...input(100000), appliedPromotions: [p] })
  const linked = computePricing({ ...input(100000), appliedPromoCodes: [selected] })
  expect(direct.total).toBe(90000)
  expect(linked.total).toBe(90000)
  expect(linked).toEqual(direct)
})

describe('LP02–04/08 shared Go and TypeScript golden cases through selection', () => {
  it.each(golden)('$name', ({ subtotal, config, discount, total }) => {
    const p = promo(config), selected = select(p, subtotal)
    const direct = computePricing({ ...input(subtotal), appliedPromotions: [p] })
    const linked = computePricing({ ...input(subtotal), appliedPromoCodes: [selected] })
    expect(linkedPromoShape(selected).tieredConfig).toEqual(config ?? null)
    expect(linked).toEqual(direct)
    expect(linked.promoDiscountAmount).toBe(discount)
    expect(linked.total).toBe(total)
  })
})

it('LP05 duplicate same code is ignored; exclusive replacement and combinability remain', () => {
  for (const combinable of [false, true]) {
    const selected = select({ ...promo(golden[0].config), combinable })
    const action = { type: 'APPLY_PROMO_CODE' as const, code: selected, combinable: !!selected.combinable }
    const first = cashierReducer({ ...CASHIER_INITIAL_STATE, cart: input(100000).cart }, action)
    expect(cashierReducer(first, action)).toEqual(first)
    expect(first.appliedPromoCodes).toHaveLength(1)
    const other = { ...selected, code: 'Second-Raw-Code', promotion: { ...selected.promotion!, id: 'independent-promotion' } }
    const next = cashierReducer(first, { ...action, code: other })
    expect(next.appliedPromoCodes.map(c => c.code)).toEqual(combinable ? ['MiXeD-Code', 'Second-Raw-Code'] : ['Second-Raw-Code'])
    expect(next.appliedPromoCodes.every(c => c.combinable === combinable)).toBe(true)
  }
})

it('LP05/07 eligibility intersection and raw assignment identity remain exact', () => {
  const p = promo(golden[0].config)
  for (const [c, p2, context] of [
    [{ ...code, minPurchase: 100001 }, p, ctx],
    [code, { ...p, minPurchase: 100001 }, ctx],
    [code, { ...p, outletIds: ['other'] }, ctx],
    [code, p, { ...ctx, customerId: 'raw-customer' }],
    [code, p, { ...ctx, hasCustomer: false, customerId: undefined }],
    [{ ...code, usageLimit: 1, usageCount: 1 }, p, ctx],
  ] as [Code, Promotion, PromoEvalContext][]) {
    expect(decideApplyCode('mixed-code', [c], context, [p2]).ok).toBe(false)
  }
  expect(select(p).code).toBe('MiXeD-Code')
})

it('LP06 ordinary linked and unlinked controls preserve discounts', () => {
  for (const [type, value, expected] of [['percentage', 10, 90000], ['fixed', 5000, 95000]] as const) {
    const p: Promotion = { ...promo(), type, value }
    expect(computePricing({ ...input(100000), appliedPromoCodes: [select(p)] }).total).toBe(expected)
    const decision = decideApplyCode('mixed-code', [{ ...code, promotionId: null, type, value }], ctx)
    if (!decision.ok) throw new Error(decision.reason)
    expect(decision.code.promotion).toBeUndefined()
    expect(computePricing({ ...input(100000), appliedPromoCodes: [decision.code] }).total).toBe(expected)
  }
})

it('LP07 computing does not mutate cart, catalog, raw code or selected snapshot', () => {
  const p = promo(golden[0].config), selected = select(p), i = { ...input(100000), appliedPromoCodes: [selected] }
  const before = structuredClone({ p, code, selected, i })
  function freeze(value: object) { Object.freeze(value); for (const v of Object.values(value)) if (v && typeof v === 'object') freeze(v) }
  freeze(p); freeze(selected); freeze(i)
  computePricing(i)
  expect({ p, code, selected, i }).toEqual(before)
})
