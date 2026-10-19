import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A30 source-level guard on the money path (CashierScreen has no DOM harness): the cashier screen
// must find customers by phone only, never read a customer list from the snapshot, remember the
// customers it uses, and keep the offline customer_create flow.
const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')

describe('CashierScreen customer privacy wiring (A30)', () => {
  it('looks customers up by phone, not by typed text', () => {
    expect(src).toContain('lookupCustomerByPhone(')
    expect(src).not.toMatch(/\blookupCustomers\(/)
  })

  it('no longer reads a customer list from the synced snapshot', () => {
    expect(src).not.toMatch(/snapshot\.customers/)
    expect(src).not.toMatch(/snapCustomers/)
  })

  it('uses the tablet memory for offline hits and remembers selected and created customers', () => {
    expect(src).toContain('getKnownCustomers()')
    expect(src).toContain('.findByPhone(')
    expect((src.match(/\.remember\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('still creates new customers offline through the outbox (customer_create unchanged)', () => {
    expect(src).toContain("engine.enqueue('customer_create', { customerId: id, name, phone, email }, id)")
  })

  it('surfaces a lookup failure message to the picker', () => {
    expect(src).toContain('lookupFailureMessage(')
    expect(src).toContain('lookupError=')
  })
})
