import { describe, it, expect } from 'vitest'
import { applyPendingStock, stockFor } from './stock'

const products = [
  { id: 'p1', name: 'A', variants: [{ size: '10ml', price: 1, stock: 5, sku: '' }, { size: '2ml', price: 1, stock: 0, sku: '' }], isActive: true, brand: '', categoryId: '', createdAt: '' },
] as any

describe('applyPendingStock', () => {
  it('subtracts pending deltas, leaving untouched variants as-is', () => {
    const out = applyPendingStock(products, { 'p1|10ml': 2 })
    expect(out[0].variants[0].stock).toBe(3)
    expect(out[0].variants[1].stock).toBe(0)
  })
  it('allows display to go negative', () => {
    const out = applyPendingStock(products, { 'p1|2ml': 3 })
    expect(out[0].variants[1].stock).toBe(-3)
  })
})
describe('stockFor', () => {
  it('reads a variant stock', () => {
    expect(stockFor(products, 'p1', '10ml')).toBe(5)
  })
  it('returns null for an unknown product/size', () => {
    expect(stockFor(products, 'pX', '10ml')).toBeNull()
    expect(stockFor(products, 'p1', '99ml')).toBeNull()
  })
})
