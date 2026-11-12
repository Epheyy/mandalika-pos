import { describe, expect, it } from 'vitest'
import type { DiscountCode, Promotion, PromotionInput } from '@mandalika/api'
import { codeToInput } from './discountCodeForm'
import { duplicateInput, promotionToInput } from './promotionForm'

// Every key of the write schema. A new field in PromotionInput fails the type check here until it is listed,
// and then the coverage test below until promotionToInput carries it.
const PROMOTION_INPUT_KEYS = [
  'name', 'description', 'type', 'value', 'minPurchase', 'applicableProductIds', 'applicableVariantKeys',
  'applicableVariantSizes', 'outletIds', 'combinable', 'combinableWith', 'activeFromHour', 'activeToHour',
  'activeDays', 'isActive', 'startDate', 'endDate', 'codeOnly', 'autoApply', 'bxgyConfig', 'tieredConfig', 'bundleConfig', 'bundleDiscountConfig',
] as const satisfies readonly (keyof PromotionInput)[]

const P = '00000000-0000-4000-8300-000000000001'
const R = '00000000-0000-4000-8300-000000000002'
const OUTLET_A = '00000000-0000-4000-8300-0000000000a1'
const GONE_OUTLET = '00000000-0000-4000-8300-0000000000ff' // an outlet no longer in the outlet list

/** A promotion with EVERY field set to a non-default value. */
const base: Promotion = {
  id: '00000000-0000-4000-8300-0000000000c1',
  createdAt: '2026-10-01T03:00:00Z',
  name: 'Promo Lengkap',
  description: 'Semua kolom terisi',
  type: 'percentage',
  value: 15,
  minPurchase: 250000,
  applicableProductIds: [P],
  applicableVariantKeys: [`${R}::50 ml`],
  applicableVariantSizes: ['50 ml', '100 ml'],
  outletIds: [OUTLET_A, GONE_OUTLET],
  combinable: true,
  combinableWith: ['00000000-0000-4000-8300-0000000000c9'],
  activeFromHour: '10:00',
  activeToHour: '18:30',
  activeDays: [1, 3, 5],
  isActive: true,
  startDate: '2026-11-01',
  endDate: '2026-11-30',
  codeOnly: true,
  autoApply: false,
  bxgyConfig: null,
  tieredConfig: null,
  bundleConfig: null,
  bundleDiscountConfig: null,
}

const FIXTURES: Record<string, Promotion> = {
  percentage: base,
  fixed: { ...base, type: 'fixed', value: 25000 },
  bogo: { ...base, type: 'bogo', value: 0 },
  buy_x_get_y: {
    ...base, type: 'buy_x_get_y', value: 0,
    bxgyConfig: {
      buyQuantity: 3, getQuantity: 2, buyProductIds: [`${P}|M`, R], getProductIds: [`${R}|L`],
      getDiscountKind: 'fixed', getDiscountValue: 15000, maxApplications: 4,
    },
  },
  tiered: {
    ...base, type: 'tiered', value: 0,
    tieredConfig: { tiers: [{ minSubtotal: 100000, kind: 'percentage', value: 5 }, { minSubtotal: 300000, kind: 'fixed', value: 40000 }] },
  },
  bundle: {
    ...base, type: 'bundle', value: 0,
    bundleConfig: { slots: [{ productKeys: [`${P}|M`, `${P}|L`], quantity: 2 }, { productKeys: [R], quantity: 1 }], bundlePrice: 199000, maxApplications: 3 },
  },
  bundle_discount: {
    ...base, type: 'bundle_discount', value: 10,
    bundleDiscountConfig: { kind: 'percentage', lines: ['EXTRAIT DE PARFUM'], sizes: ['110ml'] },
  },
}

const omit = <T extends object>(o: T, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

describe.each(Object.entries(FIXTURES))('promotionToInput round trip: %s', (_type, promo) => {
  it('sends back exactly the stored body, nothing dropped', () => {
    expect(promotionToInput(promo)).toEqual(omit(promo, ['id', 'createdAt']))
  })

  it('carries every field of the write schema', () => {
    const out = promotionToInput(promo)
    for (const key of PROMOTION_INPUT_KEYS) expect(out, `missing ${key}`).toHaveProperty(key)
  })

  it('a duplicate differs only in the name and is saved inactive', () => {
    expect(duplicateInput({ ...promo, isActive: true })).toEqual({ ...promotionToInput(promo), name: 'Promo Lengkap (Salinan)', isActive: false })
  })

  it('does not mutate the stored promotion', () => {
    const before = JSON.stringify(promo)
    promotionToInput(promo)
    expect(JSON.stringify(promo)).toBe(before)
  })
})

describe('promotionToInput autoApply', () => {
  it('round-trips true and false (a PUT would otherwise reset it)', () => {
    expect(promotionToInput({ ...base, codeOnly: false, autoApply: true }).autoApply).toBe(true)
    expect(promotionToInput({ ...base, autoApply: false }).autoApply).toBe(false)
  })

  it('treats a missing field (older server) as false', () => {
    expect(promotionToInput({ ...base, autoApply: undefined }).autoApply).toBe(false)
  })

  it('a duplicate keeps it', () => {
    expect(duplicateInput({ ...base, codeOnly: false, autoApply: true }).autoApply).toBe(true)
  })
})

describe('promotionToInput keeps fields the form has no control for', () => {
  it('carries applicableVariantSizes and combinableWith (a PUT would otherwise empty them)', () => {
    const out = promotionToInput(base)
    expect(out.applicableVariantSizes).toEqual(['50 ml', '100 ml'])
    expect(out.combinableWith).toEqual(['00000000-0000-4000-8300-0000000000c9'])
  })

  it('keeps outlet ids that are not in the current outlet list', () => {
    expect(promotionToInput(base).outletIds).toEqual([OUTLET_A, GONE_OUTLET])
  })

  it('keeps nulls as nulls and empty hours as no hours (never 00:00-23:59, never every outlet)', () => {
    const open: Promotion = { ...base, minPurchase: null, combinable: null, activeFromHour: null, activeToHour: null, activeDays: [], outletIds: [] }
    const out = promotionToInput(open)
    expect(out.minPurchase).toBeNull()
    expect(out.combinable).toBeNull()
    expect(out.activeFromHour).toBeUndefined()
    expect(out.activeToHour).toBeUndefined()
    expect(out.activeDays).toEqual([])
    expect(out.outletIds).toEqual([])
  })
})

const code: DiscountCode = {
  id: '00000000-0000-4000-8300-0000000000d1',
  createdAt: '2026-10-02T03:00:00Z',
  code: 'Raw-Mixed-Case',
  promotionId: '00000000-0000-4000-8300-0000000000c1',
  type: 'fixed',
  value: 20000,
  minPurchase: 150000,
  usageLimit: 40,
  perCustomerLimit: 2,
  customerId: '00000000-0000-4000-8300-000000000081',
  customerName: 'Synthetic Customer',
  usageCount: 7,
  isActive: true,
  startDate: '2026-11-01',
  endDate: '2026-12-31',
  combinable: true,
}

describe('codeToInput round trip', () => {
  it('sends back exactly the stored body: code case, quota, per-customer cap, holder, link, combinable', () => {
    expect(codeToInput(code)).toEqual(omit(code, ['id', 'createdAt', 'customerName', 'usageCount']))
  })

  it('keeps an unlimited quota and no holder as null, not 0', () => {
    const open: DiscountCode = { ...code, usageLimit: null, perCustomerLimit: null, customerId: null, customerName: null, minPurchase: null, combinable: null, promotionId: null }
    const out = codeToInput(open)
    expect(out.usageLimit).toBeNull()
    expect(out.perCustomerLimit).toBeNull()
    expect(out.customerId).toBeNull()
    expect(out.minPurchase).toBeNull()
    expect(out.combinable).toBeNull()
    expect(out.promotionId).toBeUndefined()
  })

  it('never sends the holder name (display only)', () => {
    expect(codeToInput(code)).not.toHaveProperty('customerName')
  })
})
