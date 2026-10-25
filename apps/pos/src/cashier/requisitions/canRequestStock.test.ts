import { describe, expect, it } from 'vitest'
import { canRequestStock } from '@mandalika/types'

describe('canRequestStock', () => {
  it('admin always; cashier only with request_stock; null/undefined never', () => {
    expect(canRequestStock({ role: 'admin', permissions: [] })).toBe(true)
    expect(canRequestStock({ role: 'cashier', permissions: ['request_stock'] })).toBe(true)
    expect(canRequestStock({ role: 'cashier', permissions: ['process_refund'] })).toBe(false)
    expect(canRequestStock({ role: 'cashier', permissions: [] })).toBe(false)
    expect(canRequestStock({ role: 'cashier' })).toBe(false)
    expect(canRequestStock({ role: 'manager', permissions: null })).toBe(false)
    expect(canRequestStock(null)).toBe(false)
    expect(canRequestStock(undefined)).toBe(false)
  })
})
