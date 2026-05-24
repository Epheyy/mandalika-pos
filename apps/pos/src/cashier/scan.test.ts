import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { buildScanIndex, resolveScan } from './scan'

type Product = components['schemas']['Product']
type ProductVariant = components['schemas']['ProductVariant']

function makeVariant(size: string, barcode?: string): ProductVariant {
  return { size, price: 1000, stock: 5, sku: `SKU-${size}`, barcode }
}

function makeProduct(id: string, name: string, variants: ProductVariant[]): Product {
  return {
    id,
    name,
    brand: 'Mandalika',
    categoryId: 'cat-1',
    variants,
    isFeatured: false,
    isFavourite: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('buildScanIndex', () => {
  it('maps each non-empty variant barcode to its product and variant', () => {
    const p = makeProduct('p1', 'Holy Sweet', [makeVariant('10ml', 'BC-10'), makeVariant('30ml', 'BC-30')])
    const index = buildScanIndex([p])
    expect(index.size).toBe(2)
    expect(index.get('BC-10')).toEqual({ product: p, variant: p.variants[0] })
    expect(index.get('BC-30')?.variant.size).toBe('30ml')
  })

  it('skips variants with empty or undefined barcode', () => {
    const p = makeProduct('p1', 'X', [makeVariant('10ml', ''), makeVariant('30ml', undefined)])
    expect(buildScanIndex([p]).size).toBe(0)
  })

  it('trims whitespace from the barcode key', () => {
    const p = makeProduct('p1', 'X', [makeVariant('10ml', '  BC-10  ')])
    expect(buildScanIndex([p]).get('BC-10')).toBeDefined()
  })

  it('keeps the first occurrence when a barcode repeats across products', () => {
    const first = makeProduct('p1', 'First', [makeVariant('10ml', 'DUP')])
    const second = makeProduct('p2', 'Second', [makeVariant('20ml', 'DUP')])
    const index = buildScanIndex([first, second])
    expect(index.size).toBe(1)
    expect(index.get('DUP')?.product.id).toBe('p1')
  })
})

describe('resolveScan', () => {
  const product = makeProduct('p1', 'Holy Sweet', [makeVariant('10ml', 'BC-10')])
  const index = buildScanIndex([product])

  it('resolves an exact match', () => {
    expect(resolveScan(index, 'BC-10')?.variant.size).toBe('10ml')
  })

  it('resolves after trimming whitespace (wedge/CR artifacts)', () => {
    expect(resolveScan(index, '  BC-10 ')?.variant.size).toBe('10ml')
  })

  it('returns null for an unknown code', () => {
    expect(resolveScan(index, 'NOPE')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(resolveScan(index, '')).toBeNull()
  })
})
