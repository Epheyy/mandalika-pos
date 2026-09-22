import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { buildReceipt, type ReceiptData } from '@mandalika/printer'
import { cashierReducer, CASHIER_INITIAL_STATE } from './state/cashierReducer'
import { computePricing, type PricingInput } from './pricing'
import { decideApplyCode, validateCode } from './promoValidate'
import { buildPromotionMetadata } from './promotionMetadata'

type Code = components['schemas']['DiscountCode']
type Promotion = components['schemas']['Promotion']
const ctx = { now: new Date('2026-09-21T05:00:00Z'), outletId: 'outlet', subtotal: 100000, hasCustomer: false }
const code = (extra: Partial<Code> = {}): Code => ({ id: 'code', code: 'Raw-Code', type: 'percentage', value: 10, isActive: true, usageCount: 0, createdAt: '', ...extra })
const promo: Promotion = { id: 'generic', name: 'Generic', type: 'percentage', value: 10, isActive: true, combinable: true, createdAt: '' }
const line = { productId: 'product', productName: 'Scent', variantSize: 'M', quantity: 1, price: 100000, subtotal: 100000 }
const start = { ...CASHIER_INITIAL_STATE, cart: [line] }
const pricing = (hasCustomer: boolean, extra: Partial<PricingInput> = {}) => computePricing({
  cart: [line], discountType: 'fixed', surchargeType: 'fixed', discountRunning: 0, surchargeRunning: 0,
  appliedPromotions: [], appliedPromoCodes: [], settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as PricingInput['settings'],
  loyalty: { enabled: true, pointsPerThousand: 1, redemptionRate: 100, tierEnabled: false },
  hasCustomer, customerPoints: 100, pointsRedeemed: 100, ...extra,
})

describe('A24 feature-specific guest eligibility', () => {
  it.each([{ perCustomerLimit: 1 }, { customerId: 'customer' }])('rejects restricted code %j for guests', restriction => {
    expect(decideApplyCode('raw-code', [code(restriction)], ctx).ok).toBe(false)
    expect(decideApplyCode('raw-code', [code(restriction)], { ...ctx, hasCustomer: true, customerId: 'customer' }).ok).toBe(true)
  })
  it('preserves raw generic linked code identity and pricing without a customer', () => {
    const d = decideApplyCode('raw-code', [code({ promotionId: promo.id })], ctx, [promo])
    expect(d.ok).toBe(true)
    if (!d.ok) throw new Error(d.reason)
    const s = cashierReducer(start, { type: 'APPLY_PROMO_CODE', code: d.code, combinable: true })
    const result = pricing(false, { appliedPromoCodes: s.appliedPromoCodes })
    expect(result.total).toBe(90000)
    expect(result.earnedPoints).toBe(0)
    expect(result.redeemedPoints).toBe(0)
    expect(buildPromotionMetadata(s, result)).toMatchObject({ promotionIds: [], discountCodes: ['Raw-Code'] })
  })
  it.each(['percentage', 'fixed'] as const)('preserves generic %s promotion for guests', type => {
    expect(pricing(false, { appliedPromotions: [{ ...promo, type, value: type === 'fixed' ? 10000 : 10 }] }).total).toBe(90000)
  })
  it('ignores stale redemption balance for a guest, preserving registered earning/redemption', () => {
    expect(pricing(false)).toMatchObject({ total: 100000, earnedPoints: 0, redeemedPoints: 0, redeemAmount: 0 })
    expect(pricing(true)).toMatchObject({ total: 90000, earnedPoints: 100, redeemedPoints: 100, redeemAmount: 10000 })
  })
  it('clears customer loyalty and removes only the rejected code while preserving generic discount', () => {
    const selected = { ...start, selectedCustomer: { id: 'customer', name: 'Customer', phone: '+123', points: 100 } as components['schemas']['Customer'], pointsToRedeem: 20,
      cart: [line, { ...line, isReward: true, rewardConditionId: 'loyalty', price: 0, subtotal: 0 }],
      appliedPromotions: [promo], appliedPromoCodes: [{ code: 'Raw-Code', type: 'fixed' as const, value: 1000, combinable: true }] }
    let s = cashierReducer(selected, { type: 'SET_CUSTOMER', customer: null })
    expect(s.cart).toEqual([line])
    expect(s.pointsToRedeem).toBe(0)
    expect(s.selectedCustomer).toBeNull()
    expect(validateCode(code({ customerId: 'customer' }), ctx)).toContain('wrong_customer')
    s = cashierReducer(s, { type: 'REMOVE_PROMO_CODE', code: 'Raw-Code' })
    expect(s.appliedPromotions).toEqual([promo])
    expect(s.appliedPromoCodes).toEqual([])
    expect(pricing(false, { appliedPromotions: s.appliedPromotions }).total).toBe(90000)
  })
  it.each([false, true])('renders guest receipt bytes, reprint=%s, without fabricated identity', reprint => {
    const receipt: ReceiptData = { orderRef: 'GUEST-1', pending: true, dateTime: ctx.now, lines: [{ name: 'Scent', qty: 1, unitPrice: 100000, amount: 100000 }], subtotal: 100000, discountAmount: 0, taxAmount: 0, total: 100000, paymentLabel: 'Tunai', amountPaid: 100000, change: 0, customerName: null, customerPhone: null, cashierName: 'Cashier' }
    const text = new TextDecoder().decode(buildReceipt(receipt, { headerText: 'Test', footerText: '', showTax: false, showCashier: true, showCustomerName: true, showCustomerPhone: true }, reprint))
    expect(text).toContain('GUEST-1')
    expect(text).toContain('Scent')
    expect(text).not.toMatch(/Pelanggan:|Telp:|null|undefined/)
    expect(text.includes('CETAK ULANG')).toBe(reprint)
  })
})
