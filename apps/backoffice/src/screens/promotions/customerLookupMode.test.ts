import { describe, expect, it } from 'vitest'
import { CUSTOMER_PHONE_HINT, isPhoneOnlyCustomerLookup } from './customerLookupMode'

// Mirror of the server's customerScope (backend/internal/handlers/customerscope.go, A30): the
// discount-code customer picker can only browse by name for callers the server lets browse.
describe('isPhoneOnlyCustomerLookup', () => {
  it('admin browses', () => {
    expect(isPhoneOnlyCustomerLookup({ role: 'admin', permissions: [] })).toBe(false)
  })
  it('a manager with manage_customers browses', () => {
    expect(isPhoneOnlyCustomerLookup({ role: 'manager', permissions: ['manage_customers'] })).toBe(false)
  })
  it('a manager without manage_customers is phone-only', () => {
    expect(isPhoneOnlyCustomerLookup({ role: 'manager', permissions: ['manage_promotions'] })).toBe(true)
  })
  it('a cashier is phone-only even with manage_customers', () => {
    expect(isPhoneOnlyCustomerLookup({ role: 'cashier', permissions: ['manage_customers'] })).toBe(true)
  })
  it('no user (not loaded) is phone-only', () => {
    expect(isPhoneOnlyCustomerLookup(null)).toBe(true)
    expect(isPhoneOnlyCustomerLookup(undefined)).toBe(true)
  })
  it('explains how to search', () => {
    expect(CUSTOMER_PHONE_HINT).toContain('nomor telepon')
  })
})
