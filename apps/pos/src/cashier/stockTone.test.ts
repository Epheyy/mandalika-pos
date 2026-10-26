import { describe, expect, it } from 'vitest'
import { LOW_STOCK_THRESHOLD, stockLabel, stockTone } from './stockTone'

describe('stockTone', () => {
  it('is ok from 3 units up', () => {
    expect(stockTone(3)).toBe('ok')
    expect(stockTone(9)).toBe('ok')
  })
  it('is warn at 1 and 2 units (D-20 threshold)', () => {
    expect(LOW_STOCK_THRESHOLD).toBe(2)
    expect(stockTone(1)).toBe('warn')
    expect(stockTone(2)).toBe('warn')
  })
  it('is danger at zero and below', () => {
    expect(stockTone(0)).toBe('danger')
    expect(stockTone(-4)).toBe('danger')
  })
})

describe('stockLabel', () => {
  it('shows the count, "Habis" at zero and a signed minus below', () => {
    expect(stockLabel(9)).toBe('Stok 9')
    expect(stockLabel(0)).toBe('Habis')
    expect(stockLabel(-2)).toBe('Stok −2')
  })
})
