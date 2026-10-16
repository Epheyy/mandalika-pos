import { describe, it, expect } from 'vitest'
import { applyPendingStock, stockFor, overstockLines, nextVariantQty, exceedsStock, oversoldSizes, OVERSELL_WARNING } from './stock'

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

describe('overstockLines', () => {
  const sp = [{ id: 'p1', name: 'A', variants: [{ size: '10ml', price: 1, stock: 1, sku: '' }], isActive: true, brand: '', categoryId: '', createdAt: '' }] as any
  it('returns nothing when negative is allowed', () => {
    expect(overstockLines([{ productId: 'p1', variantSize: '10ml', quantity: 5 }], sp, true)).toHaveLength(0)
  })
  it('flags lines over available stock when not allowed', () => {
    expect(overstockLines([{ productId: 'p1', variantSize: '10ml', quantity: 5 }], sp, false)).toHaveLength(1)
  })
  it('does not flag a line within stock', () => {
    expect(overstockLines([{ productId: 'p1', variantSize: '10ml', quantity: 1 }], sp, false)).toHaveLength(0)
  })
  it('ignores unknown products (no stock row)', () => {
    expect(overstockLines([{ productId: 'pX', variantSize: 'S', quantity: 9 }], sp, false)).toHaveLength(0)
  })
  it('aggregates same-variant lines (paid + reward) before comparing', () => {
    const sp = [{ id: 'p1', name: 'A', variants: [{ size: '10ml', price: 1, stock: 1, sku: '' }], isActive: true, brand: '', categoryId: '', createdAt: '' }] as any
    const lines = [
      { productId: 'p1', variantSize: '10ml', quantity: 1 },
      { productId: 'p1', variantSize: '10ml', quantity: 1 },
    ]
    const out = overstockLines(lines, sp, false)
    expect(out).toHaveLength(1)
    expect(out[0].quantity).toBe(2)
  })
})

// A44 owner decision 2026-10-16 (Q2): the POS never blocks an out-of-stock item. It
// warns instead and the server records the oversell.
describe('out-of-stock selling (A44 Q2)', () => {
  it('nextVariantQty is not capped by stock and never goes below zero', () => {
    expect(nextVariantQty(0, 1)).toBe(1)
    expect(nextVariantQty(5, 1)).toBe(6)
    expect(nextVariantQty(0, -1)).toBe(0)
    expect(nextVariantQty(2, -1)).toBe(1)
  })

  it('exceedsStock is true when the cart plus the addition passes the stock', () => {
    expect(exceedsStock(0, 1, 0)).toBe(true)
    expect(exceedsStock(0, 1, -2)).toBe(true)
    expect(exceedsStock(2, 1, 2)).toBe(true)
    expect(exceedsStock(1, 1, 2)).toBe(false)
    expect(exceedsStock(0, 0, 0)).toBe(false)
  })

  it('oversoldSizes lists only the chosen sizes that pass their stock, counting what is already in the cart', () => {
    const cartQty = (size: string) => (size === '10ml' ? 4 : 0)
    // 10ml: stock 5, cart 4 + 2 -> over; 2ml: stock 0, +1 -> over; 30ml: not chosen
    const p = { id: 'p1', name: 'A', variants: [
      { size: '10ml', price: 1, stock: 5, sku: '' }, { size: '2ml', price: 1, stock: 0, sku: '' }, { size: '30ml', price: 1, stock: 0, sku: '' },
    ] } as any
    expect(oversoldSizes(p, { '10ml': 2, '2ml': 1, '30ml': 0 }, cartQty)).toEqual(['10ml', '2ml'])
    expect(oversoldSizes(p, { '10ml': 1 }, cartQty)).toEqual([])
  })

  it('the warning copy tells the cashier the sale still goes through', () => {
    expect(OVERSELL_WARNING).toContain('tetap')
  })
})
