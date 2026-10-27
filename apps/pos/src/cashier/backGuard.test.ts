import { describe, expect, it } from 'vitest'
import { cashierBackLayer, type CashierBackFlags } from './backGuard'

const none: CashierBackFlags = { isBusy: false, confirmOpen: false, pickerOpen: false, successOpen: false, checkoutOpen: false, adjustmentOpen: false, cartTabActive: false }
const layer = (over: Partial<CashierBackFlags>) => cashierBackLayer({ ...none, ...over })

describe('cashierBackLayer', () => {
  it('ignores Back while an order is being committed, even with the checkout open', () => {
    expect(layer({ isBusy: true, checkoutOpen: true })).toBe('ignore-busy')
    expect(layer({ isBusy: true, confirmOpen: true, pickerOpen: true, adjustmentOpen: true })).toBe('ignore-busy')
  })

  it('closes a confirm dialog before the picker, sheet or checkout under it', () => {
    expect(layer({ confirmOpen: true, pickerOpen: true, adjustmentOpen: true, checkoutOpen: true })).toBe('close-confirm')
  })

  it('steps a picker back to the sheet list before closing the sheet', () => {
    expect(layer({ pickerOpen: true, adjustmentOpen: true })).toBe('close-picker')
    expect(layer({ adjustmentOpen: true })).toBe('close-adjustment')
  })

  it('closes success, then checkout, then the sheet, then leaves the cart tab, in that order', () => {
    expect(layer({ successOpen: true, checkoutOpen: true })).toBe('close-success')
    expect(layer({ checkoutOpen: true, adjustmentOpen: true })).toBe('close-checkout')
    expect(layer({ adjustmentOpen: true, cartTabActive: true })).toBe('close-adjustment')
    expect(layer({ cartTabActive: true })).toBe('cart-to-products')
  })

  it('consumes Back when nothing is open (a stray press never exits the POS)', () => {
    expect(layer({})).toBe('consume')
  })
})
