import { describe, expect, it } from 'vitest'
import {
  pointsPerThousandError,
  receiptCopiesError,
  redemptionRateError,
  unitCostError,
  defaultUnitCostError,
  wholeQtyError,
} from './inputRules'

describe('loyalty rate rules', () => {
  it('rejects negative, zero, empty and out-of-range rates', () => {
    for (const v of [-1, 0, NaN, undefined, 1001]) expect(pointsPerThousandError(v)).not.toBeNull()
    for (const v of [-5, 0, NaN, undefined, 100001]) expect(redemptionRateError(v)).not.toBeNull()
  })
  it('accepts sensible rates', () => {
    expect(pointsPerThousandError(1)).toBeNull()
    expect(pointsPerThousandError(0.5)).toBeNull()
    expect(redemptionRateError(100)).toBeNull()
  })
})

describe('receipt copies rule', () => {
  it('only allows whole numbers 1-5 (or unset)', () => {
    for (const v of [0, 6, -1, 2.5, NaN]) expect(receiptCopiesError(v)).not.toBeNull()
    for (const v of [1, 3, 5, undefined, null]) expect(receiptCopiesError(v)).toBeNull()
  })
})

describe('goods-in field rules', () => {
  it('quantity: whole and positive, empty means no line', () => {
    expect(wholeQtyError('')).toBeNull()
    expect(wholeQtyError('3')).toBeNull()
    expect(wholeQtyError('1.5')).toContain('bulat')
    expect(wholeQtyError('0')).toBeNull() // 0 = skip the line
    expect(wholeQtyError('-2')).toContain('negatif')
    expect(wholeQtyError('abc')).not.toBeNull()
  })
  it('unit cost: optional, zero allowed, never negative', () => {
    expect(unitCostError('')).toBeNull()
    expect(unitCostError('0')).toBeNull()
    expect(unitCostError('12500.5')).toBeNull()
    expect(unitCostError('-1')).toContain('negatif')
    expect(unitCostError('x')).not.toBeNull()
  })
})

describe('ingredient default unit cost', () => {
  it('optional, zero allowed, never negative or non-finite', () => {
    expect(defaultUnitCostError('')).toBeNull()
    expect(defaultUnitCostError('0')).toBeNull()
    expect(defaultUnitCostError('12500.5')).toBeNull()
    expect(defaultUnitCostError('-1')).toContain('negatif')
    expect(defaultUnitCostError('x')).not.toBeNull()
    expect(defaultUnitCostError('Infinity')).not.toBeNull()
    expect(defaultUnitCostError('1e20')).toContain('terlalu besar')
  })
})
