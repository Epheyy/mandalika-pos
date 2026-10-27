import type { components } from '@mandalika/api'
import { describe, expect, it } from 'vitest'
import { isLineInBundle, planSizeSwitch, sizeOptions } from './lineSizes'

type Product = components['schemas']['Product']

const product = {
  id: 'p1', name: 'Oud', isActive: true, brand: '', categoryId: '', createdAt: '',
  variants: [
    { size: '50ml', price: 350000, stock: 9, sku: 'A' },
    { size: '110ml', price: 520000, stock: 0, sku: 'B' },
  ],
} as unknown as Product
const line = { productId: 'p1', productName: 'Oud', variantSize: '50ml', price: 350000, quantity: 2, subtotal: 700000 }

describe('sizeOptions', () => {
  it('lists every size of the product in catalog order, flagging the current one', () => {
    expect(sizeOptions(product, '110ml')).toEqual([
      { size: '50ml', price: 350000, stock: 9, current: false },
      { size: '110ml', price: 520000, stock: 0, current: true },
    ])
  })
  it('is empty for an unknown or single-size product (no switch to offer)', () => {
    expect(sizeOptions(undefined, '50ml')).toEqual([])
    expect(sizeOptions({ ...product, variants: [product.variants[0]] }, '50ml')).toEqual([])
  })
})

describe('planSizeSwitch', () => {
  it('moves the same quantity to the other size as a remove + add plan', () => {
    expect(planSizeSwitch(line, product, '110ml')).toEqual({
      productId: 'p1', fromSize: '50ml', toSize: '110ml', variantQtys: { '110ml': 2 },
    })
  })
  it('refuses the current size, an unknown size and a reward line', () => {
    expect(planSizeSwitch(line, product, '50ml')).toBeNull()
    expect(planSizeSwitch(line, product, '200ml')).toBeNull()
    expect(planSizeSwitch({ ...line, isReward: true }, product, '110ml')).toBeNull()
  })
  it('refuses a line that belongs to another product', () => {
    expect(planSizeSwitch({ ...line, productId: 'p2' }, product, '110ml')).toBeNull()
  })
})

describe('isLineInBundle', () => {
  const freed = { bundleA: [{ productId: 'p1', variantSize: '50ml', quantity: 1 }] }
  it('is true only for a product+size an applied bundle moved units from', () => {
    expect(isLineInBundle(freed, 'p1', '50ml')).toBe(true)
    expect(isLineInBundle(freed, 'p1', '110ml')).toBe(false)
    expect(isLineInBundle(freed, 'p2', '50ml')).toBe(false)
    expect(isLineInBundle({}, 'p1', '50ml')).toBe(false)
  })
})
