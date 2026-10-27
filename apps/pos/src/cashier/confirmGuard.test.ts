import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { cashierReducer, CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'
import type { AppliedPromoCode } from './promoValidate'
import { findInvalidPromos, resolveConfirmGuard } from './confirmGuard'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']
type CartItem = components['schemas']['CartItem']

const NOW = new Date('2026-09-20T05:00:00Z')
const ctx = { now: NOW, outletId: 'outlet', hasCustomer: false }

const line = (id: string, price: number, quantity = 1): CartItem => ({ productId: id, productName: id, variantSize: 'M', price, quantity, subtotal: price * quantity })
const promo = (id: string, over: Partial<Promotion> = {}): Promotion => ({
  id, name: `Promo ${id}`, type: 'percentage', value: 10, isActive: true, createdAt: '', combinable: true, ...over,
})
const expired = { endDate: '2026-09-01' }
const dcode = (code: string, over: Partial<DiscountCode> = {}): DiscountCode => ({
  id: code, code, type: 'fixed', value: 5000, usageCount: 0, isActive: true, createdAt: '', ...over,
})
const applied = (code: string, combinable = true): AppliedPromoCode => ({ code, value: 5000, type: 'fixed', combinable })
const stateWith = (over: Partial<CashierState>): CashierState => ({ ...CASHIER_INITIAL_STATE, cart: [line('a', 100000)], ...over })
const run = (state: CashierState, promotions: Promotion[] = [], discountCodes: DiscountCode[] = []) =>
  resolveConfirmGuard({ state, promotions, discountCodes, ctx })
const apply = (state: CashierState, actions: ReturnType<typeof run>['actions']) => actions.reduce(cashierReducer, state)

describe('resolveConfirmGuard', () => {
  it('keeps everything when nothing is invalid', () => {
    const p = promo('A')
    const r = run(stateWith({ appliedPromotions: [p] }), [p])
    expect(r.drops).toEqual([])
    expect(r.actions).toEqual([])
    expect(r.clearAll).toBe(false)
  })

  it('one of two combinable promos invalid: only that one is removed', () => {
    const good = promo('GOOD'), bad = promo('BAD', expired)
    const state = stateWith({ appliedPromotions: [good, bad] })
    const r = run(state, [good, bad])
    expect(r.drops.map((d) => d.kind === 'promotion' && d.id)).toEqual(['BAD'])
    expect(r.messages).toEqual(['Promo Promo BAD tidak berlaku lagi (Sudah kadaluarsa). Dihapus dari keranjang; promo lain tetap.'])
    expect(apply(state, r.actions).appliedPromotions.map((p) => p.id)).toEqual(['GOOD'])
    expect(r.clearAll).toBe(false)
  })

  it('the single non-combinable promo invalid: it is removed', () => {
    const bad = promo('SOLO', { ...expired, combinable: false })
    const state = stateWith({ appliedPromotions: [bad] })
    const r = run(state, [bad])
    expect(r.drops).toHaveLength(1)
    expect(apply(state, r.actions).appliedPromotions).toEqual([])
  })

  it('code invalid: only the code is removed, the promo stays', () => {
    const good = promo('GOOD'), codeRow = dcode('OLD', { endDate: '2026-09-01' })
    const state = stateWith({ appliedPromotions: [good], appliedPromoCodes: [applied('OLD')] })
    const r = run(state, [good], [codeRow])
    expect(r.drops).toEqual([{ kind: 'code', code: 'OLD', reason: 'Sudah kadaluarsa' }])
    expect(r.messages[0]).toBe('Kode Promo OLD tidak berlaku lagi (Sudah kadaluarsa). Dihapus dari keranjang; promo lain tetap.')
    const next = apply(state, r.actions)
    expect(next.appliedPromoCodes).toEqual([])
    expect(next.appliedPromotions.map((p) => p.id)).toEqual(['GOOD'])
  })

  it('a code missing from the active catalog is dropped on its own', () => {
    const state = stateWith({ appliedPromoCodes: [applied('GONE'), applied('LIVE')] })
    const r = run(state, [], [dcode('LIVE')])
    expect(r.drops).toEqual([{ kind: 'code', code: 'GONE', reason: 'kode tidak ditemukan' }])
    expect(apply(state, r.actions).appliedPromoCodes.map((c) => c.code)).toEqual(['LIVE'])
  })

  it('separate-set BXGY with unmet buy criteria: strips its reward line, keeps the other promo', () => {
    const bxgy = promo('BX', {
      type: 'buy_x_get_y', value: 0,
      bxgyConfig: { buyQuantity: 2, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['gift'], getDiscountKind: 'percentage', getDiscountValue: 100 },
    })
    const other = promo('OK')
    const reward: CartItem = { ...line('gift', 0), isReward: true, rewardPromotionId: 'BX' }
    const state = stateWith({ cart: [line('a', 100000, 1), reward], appliedPromotions: [bxgy, other] })
    const r = run(state, [bxgy, other])
    expect(r.drops).toEqual([expect.objectContaining({ kind: 'promotion', id: 'BX', stripRewards: true })])
    const next = apply(state, r.actions)
    expect(next.cart.some((c) => c.isReward)).toBe(false)
    expect(next.appliedPromotions.map((p) => p.id)).toEqual(['OK'])
  })

  it('a drop with no cart effect adds nothing in the second pass', () => {
    const bad = promo('BAD', expired), good = promo('GOOD', { minPurchase: 50000 })
    const state = stateWith({ appliedPromotions: [bad, good] })
    const r = run(state, [bad, good])
    expect(r.drops).toHaveLength(1)
  })

  it('does not report a drop twice across the two passes', () => {
    const bad = promo('BAD', expired)
    const state = stateWith({ appliedPromotions: [bad] })
    expect(findInvalidPromos({ state, promotions: [bad], discountCodes: [], ctx })).toHaveLength(1)
    expect(run(state, [bad]).drops).toHaveLength(1)
  })

  it('flags clearAll when the survivors still break the combinable rule', () => {
    const excl = promo('EXCL', { combinable: false }), other = promo('OTHER')
    const r = run(stateWith({ appliedPromotions: [excl, other] }), [excl, other])
    expect(r.drops).toEqual([])
    expect(r.clearAll).toBe(true)
  })
})
