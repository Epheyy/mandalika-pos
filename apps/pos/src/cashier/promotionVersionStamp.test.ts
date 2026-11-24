import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { decideApplyCode, type PromoEvalContext, type AppliedPromoCode } from './promoValidate'
import { buildPromotionMetadata } from './promotionMetadata'

type Promotion = components['schemas']['Promotion']
type Code = components['schemas']['DiscountCode']

const ctx: PromoEvalContext = { now: new Date('2026-09-20T05:00:00Z'), outletId: 'outlet', subtotal: 100000, hasCustomer: false }
const promo = (version?: number): Promotion => ({ id: 'promo-1', name: 'Sale 10', type: 'percentage', value: 10, isActive: true, createdAt: '', combinable: true, ...(version === undefined ? {} : { version }) })
const code = (extra: Partial<Code> = {}): Code => ({ id: 'c1', code: 'HEMAT', type: 'fixed', value: 5000, usageCount: 0, isActive: true, createdAt: '', ...extra })
const cart = [{ productId: 'p', productName: 'P', variantSize: '120ml', price: 100000, quantity: 1, subtotal: 100000 }]
const state = (appliedPromotions: Promotion[], appliedPromoCodes: AppliedPromoCode[]) =>
  ({ cart, appliedPromotions, appliedPromoCodes, appliedDiscountType: 'fixed' as const, discountRunning: 0 }) as Parameters<typeof buildPromotionMetadata>[0]
const derived = { subtotal: 100000, manualDiscountAmount: 0 }
const select = (c: Code, p: Promotion): AppliedPromoCode => {
  const r = decideApplyCode(c.code, [c], ctx, [p])
  if (!r.ok) throw new Error(r.reason)
  return r.code
}

describe('discountBreakdown stamps promotion and code versions (A10)', () => {
  it('a direct promotion carries promotionId and promotionVersion; label, kind, value, amount are unchanged', () => {
    const { discountBreakdown } = buildPromotionMetadata(state([promo(3)], []), derived)
    expect(discountBreakdown).toEqual([{ label: 'Sale 10', kind: 'percentage', value: 10, amount: 10000, promotionId: 'promo-1', promotionVersion: 3 }])
  })

  it('a linked code keeps both versions through linkedPromoShape (the A23 failure mode)', () => {
    const selected = select(code({ promotionId: 'promo-1', version: 7 }), promo(3))
    const { discountBreakdown } = buildPromotionMetadata(state([], [selected]), derived)
    expect(discountBreakdown).toEqual([{ label: 'HEMAT', kind: 'percentage', value: 10, amount: 10000, promotionId: 'promo-1', promotionVersion: 3, codeVersion: 7 }])
  })

  it('an unlinked code carries only its own version', () => {
    const selected = select(code({ version: 2 }), promo(3))
    const { discountBreakdown } = buildPromotionMetadata(state([], [selected]), derived)
    expect(discountBreakdown).toEqual([{ label: 'HEMAT', kind: 'fixed', value: 5000, amount: 5000, codeVersion: 2 }])
  })

  it('a cached promotion or code from an older server (no version) stamps no version and does not throw', () => {
    const direct = buildPromotionMetadata(state([promo()], []), derived).discountBreakdown
    expect(direct).toEqual([{ label: 'Sale 10', kind: 'percentage', value: 10, amount: 10000, promotionId: 'promo-1' }])
    const linked = buildPromotionMetadata(state([], [select(code({ promotionId: 'promo-1' }), promo())]), derived).discountBreakdown
    expect(linked).toEqual([{ label: 'HEMAT', kind: 'percentage', value: 10, amount: 10000, promotionId: 'promo-1' }])
    const unlinked = buildPromotionMetadata(state([], [select(code(), promo())]), derived).discountBreakdown
    expect(unlinked).toEqual([{ label: 'HEMAT', kind: 'fixed', value: 5000, amount: 5000 }])
  })
})
