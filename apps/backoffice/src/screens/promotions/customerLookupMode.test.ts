import { describe, expect, it } from 'vitest'
import { CUSTOMER_PHONE_HINT, customerLookupTerm, isPhoneOnlyCustomerLookup } from './customerLookupMode'

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

// M1: a phone-only lookup spends the shared per-account budget, so it runs only on an explicit
// search (Enter / Cari), never while typing. Customer readers keep the live typeahead.
describe('customerLookupTerm', () => {
  it('phone-only: nothing until the text was submitted, and only the submitted text', () => {
    expect(customerLookupTerm(true, '0812999', '')).toBe('')
    expect(customerLookupTerm(true, '081299998888', '')).toBe('')
    expect(customerLookupTerm(true, '081299998889', '081299998888')).toBe('081299998888')
  })
  it('phone-only: a submitted text that is not a full phone is not looked up', () => {
    expect(customerLookupTerm(true, '0812', '0812')).toBe('')
    expect(customerLookupTerm(true, 'Alice', 'Alice')).toBe('')
  })
  it('readers: the live trimmed typeahead text', () => {
    expect(customerLookupTerm(false, '  Ali ', '')).toBe('Ali')
    expect(customerLookupTerm(false, '   ', '')).toBe('')
  })
})
