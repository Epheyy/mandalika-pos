import { describe, expect, it } from 'vitest'
import { compactRupiah, isAllZero } from './axisFormat'

describe('compactRupiah', () => {
  it('uses jt / rb / plain', () => {
    expect(compactRupiah(18_000_000)).toBe('Rp 18 jt')
    expect(compactRupiah(1_500_000)).toBe('Rp 1,5 jt')
    expect(compactRupiah(500_000)).toBe('Rp 500 rb')
    expect(compactRupiah(1_000)).toBe('Rp 1 rb')
    expect(compactRupiah(750)).toBe('Rp 750')
    expect(compactRupiah(0)).toBe('Rp 0')
  })
  it('keeps the sign of a negative day', () => {
    expect(compactRupiah(-250_000)).toBe('-Rp 250 rb')
  })
})

describe('isAllZero', () => {
  it('detects an empty or all-zero series', () => {
    expect(isAllZero([])).toBe(true)
    expect(isAllZero([0, 0])).toBe(true)
    expect(isAllZero([0, -5])).toBe(false)
  })
})
