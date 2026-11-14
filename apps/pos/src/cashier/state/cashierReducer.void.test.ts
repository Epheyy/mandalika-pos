import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { CASHIER_INITIAL_STATE, cashierReducer, type CashierAction, type CashierState } from './cashierReducer'
import type { HeldRestoreEnv } from '../heldRestore'
import { startVoidDraftActions } from '../void/voidCheckout'
import type { VoidDraft } from '../void/voidReplacement'

type Order = components['schemas']['Order']

const NOW = new Date('2026-11-14T03:00:00Z')
const product = { id: 'a', name: 'P-a', isActive: true, variants: [{ size: 'S', price: 50000, stock: 9 }] } as never
const env: HeldRestoreEnv = { products: [product], promotions: [], discountCodes: [], ctx: { now: NOW, outletId: 'o1' } }
const order = {
  id: 'ord1', orderNumber: 'BSD-1', status: 'completed', total: 100000, paymentMethod: 'qris',
  items: [{ id: 'i1', lineNo: 0, productId: 'a', productName: 'P-a', variantSize: 'S', price: 50000, quantity: 2, subtotal: 100000, netAmount: 100000, refundGroup: null, refundedQty: 0 }],
} as unknown as Order
const draft: VoidDraft = {
  orderId: 'ord1', orderNumber: 'BSD-1', originalTotal: 100000, originalTenders: [{ method: 'qris', amount: 100000 }],
  reason: 'salah_barang', note: '', stockChoices: {}, shiftId: 's1', amountsLocked: false, kind: 'void_and_replace',
}
const fold = (actions: CashierAction[], from: CashierState = CASHIER_INITIAL_STATE): CashierState => actions.reduce(cashierReducer, from)
const started = (): CashierState =>
  fold(startVoidDraftActions(order, draft, env, { replacementUuid: 'new-uuid', shiftId: 's1', now: NOW.getTime() }).actions)

describe('void draft in the cashier reducer', () => {
  it('startVoidDraftActions leaves the draft set and the replacement cart filled', () => {
    const s = started()
    expect(s.voidDraft?.orderNumber).toBe('BSD-1')
    expect(s.voidDraft?.replacementUuid).toBe('new-uuid')
    expect(s.voidDraft?.startedShiftId).toBe('s1')
    expect(s.cart.map((l) => [l.productId, l.quantity])).toEqual([['a', 2]])
    expect(s.voidCorrectionChoice).toBe('adjust')
  })

  it('VOID_DRAFT_START then CART_CLEAR drops the draft', () => {
    const s = cashierReducer(started(), { type: 'CART_CLEAR' })
    expect(s.voidDraft).toBeNull()
    expect(s.cart).toEqual([])
  })

  it('VOID_DRAFT_CANCEL drops the draft AND the cart, so no plain sale is left behind', () => {
    const open = cashierReducer(started(), { type: 'OPEN_CHECKOUT', defaultMethod: 'cash' })
    const s = cashierReducer(open, { type: 'VOID_DRAFT_CANCEL' })
    expect(s.voidDraft).toBeNull()
    expect(s.cart).toEqual([])
    expect(s.isCheckoutOpen).toBe(false)
    expect(s.tenders).toEqual([])
  })

  it('RESET_SALE, CLOSE_SUCCESS and ORDER_SUCCESS clear the draft', () => {
    expect(cashierReducer(started(), { type: 'RESET_SALE' }).voidDraft).toBeNull()
    expect(cashierReducer(started(), { type: 'CLOSE_SUCCESS' }).voidDraft).toBeNull()
    const done = cashierReducer(started(), { type: 'ORDER_SUCCESS', orderId: 'new-uuid', orderNumber: 'BSD-2' })
    expect(done.voidDraft).toBeNull()
    expect(done.voidCorrectionChoice).toBe('adjust')
  })

  it('opening the checkout seeds the original payment lines under the replacement uuid, each time', () => {
    const open = cashierReducer(started(), { type: 'OPEN_CHECKOUT', defaultMethod: 'cash' })
    expect(open.splitMode).toBe(true)
    expect(open.tenders).toEqual([{ method: 'qris', amount: 100000 }])
    expect(open.splitOrderUuid).toBe('new-uuid')
    const reopened = cashierReducer(cashierReducer(open, { type: 'CLOSE_CHECKOUT' }), { type: 'OPEN_CHECKOUT', defaultMethod: 'cash' })
    expect(reopened.tenders).toEqual([{ method: 'qris', amount: 100000 }])
  })

  it('a plain sale opens the checkout with no split lines', () => {
    expect(cashierReducer(CASHIER_INITIAL_STATE, { type: 'OPEN_CHECKOUT', defaultMethod: 'cash' }).tenders).toEqual([])
  })

  it('SET_VOID_CORRECTION_CHOICE changes the choice only while a draft is open', () => {
    expect(cashierReducer(started(), { type: 'SET_VOID_CORRECTION_CHOICE', choice: 'settle' }).voidCorrectionChoice).toBe('settle')
    expect(cashierReducer(CASHIER_INITIAL_STATE, { type: 'SET_VOID_CORRECTION_CHOICE', choice: 'settle' })).toBe(CASHIER_INITIAL_STATE)
  })
})
