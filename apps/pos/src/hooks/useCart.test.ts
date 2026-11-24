import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { CASHIER_INITIAL_STATE, type CashierState } from '../cashier/state/cashierReducer'
import { useCart, type CartDerived } from './useCart'

type AppSettings = components['schemas']['AppSettings']
type LoyaltySettings = components['schemas']['LoyaltySettings']

const settings = { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as AppSettings
const loyalty = { enabled: true, pointsPerThousand: 1, redemptionRate: 100 } as LoyaltySettings
const state: CashierState = {
  ...CASHIER_INITIAL_STATE,
  cart: [{ productId: 'p', productName: 'P', variantSize: '120ml', price: 100000, quantity: 1, subtotal: 100000 }],
  selectedCustomer: { id: 'c', name: 'Budi', phone: '0812', points: 500 } as CashierState['selectedCustomer'],
  pointsToRedeem: 200,
}

function derivedFor(isOnline?: boolean): CartDerived {
  let out: CartDerived | undefined
  const Probe = () => {
    out = useCart({ state, dispatch: () => {}, settings, loyalty, ...(isOnline === undefined ? {} : { isOnline }) }).derived
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return out!
}

describe('A21: an offline sale never carries redeemed points', () => {
  it('online: the entered points are redeemed', () => {
    const d = derivedFor(true)
    expect(d.redeemedPoints).toBe(200)
    expect(d.redeemAmount).toBe(20000)
    expect(d.total).toBe(80000)
  })

  it('offline: the redeem drops to 0 and the total is the full price', () => {
    const d = derivedFor(false)
    expect(d.redeemedPoints).toBe(0)
    expect(d.redeemAmount).toBe(0)
    expect(d.total).toBe(100000)
  })

  it('isOnline omitted keeps today\'s behaviour (online)', () => {
    expect(derivedFor().redeemedPoints).toBe(200)
  })
})
