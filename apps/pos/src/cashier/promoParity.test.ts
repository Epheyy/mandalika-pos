import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { computePricing, type PricingInput } from './pricing'
import { decideApplyCode, type PromoEvalContext, type AppliedPromoCode } from './promoValidate'

// C1: a linked code's slip row is labelled "Kode X" while a direct promotion shows its name, so parity compares the money.
const moneyOnly = <T extends { discountParts: { amount: number }[] }>(r: T) => ({ ...r, discountParts: r.discountParts.map((d) => d.amount) })

type Promotion = components['schemas']['Promotion']
type Code = components['schemas']['DiscountCode']
type Golden = {
  name: string
  cart: { productId: string; variantSize: string; price: number; quantity: number; subtotal: number }[]
  promotions: Partial<Promotion>[]
  manual: { type: 'percentage' | 'fixed'; value: number }
  surcharge: { type: 'percentage' | 'fixed'; value: number }
  settings: { taxEnabled: boolean; taxRate: number; roundingEnabled: boolean; roundingType: string }
  expected: { promoDiscount: number; discountAmount: number; taxAmount: number; total: number }
}
// Same fixture file is read by Go TestPromoParityGolden. Never edit it to match an engine.
const golden: Golden[] = JSON.parse(readFileSync(new URL('../../../../backend/internal/service/testdata/promo_parity_golden.json', import.meta.url), 'utf8'))

const ctx: PromoEvalContext = { now: new Date('2026-09-20T05:00:00Z'), outletId: 'outlet', subtotal: 0, hasCustomer: true, customerId: 'c1' }
const toPromotion = (p: Partial<Promotion>): Promotion => ({ name: p.id!, isActive: true, createdAt: '', ...p }) as Promotion

function input(g: Golden): PricingInput {
  return { cart: g.cart.map(l => ({ ...l, productName: l.productId })), discountType: g.manual.type, surchargeType: g.surcharge.type,
    discountRunning: g.manual.value, surchargeRunning: g.surcharge.value, appliedPromotions: [], appliedPromoCodes: [],
    settings: g.settings as unknown as PricingInput['settings'], loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as PricingInput['loyalty'],
    hasCustomer: true, pointsRedeemed: 0, customerPoints: 0 }
}

// Linked path: a code per promotion (its own flat value is a decoy), selected through decideApplyCode.
function linkedCodes(g: Golden, promos: Promotion[]): AppliedPromoCode[] {
  const subtotal = g.cart.reduce((s, l) => s + l.subtotal, 0)
  const codes: Code[] = promos.map(p => ({ id: `c-${p.id}`, code: `Code-${p.id}`, type: 'fixed', value: 987, promotionId: p.id, usageCount: 0, isActive: true, createdAt: '' }) as Code)
  return codes.map(c => {
    const r = decideApplyCode(c.code, codes, { ...ctx, subtotal }, promos)
    if (!r.ok) throw new Error(r.reason)
    return r.code
  })
}

it('golden fixture count is pinned', () => {
  expect(golden).toHaveLength(26)
})

describe('shared Go and TypeScript promo parity matrix', () => {
  it.each(golden)('$name', g => {
    const promos = g.promotions.map(toPromotion)
    const direct = computePricing({ ...input(g), appliedPromotions: promos })
    const linked = computePricing({ ...input(g), appliedPromoCodes: linkedCodes(g, promos) })
    for (const r of [direct, linked]) {
      expect(r.promoDiscountAmount).toBe(g.expected.promoDiscount)
      expect(r.discountAmount).toBe(g.expected.discountAmount)
      expect(r.taxAmount).toBe(g.expected.taxAmount)
      expect(r.total).toBe(g.expected.total)
    }
    expect(moneyOnly(linked)).toEqual(moneyOnly(direct))
  })
})
