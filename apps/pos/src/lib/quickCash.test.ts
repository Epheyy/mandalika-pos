import { describe, expect, it } from 'vitest'
import { quickCashAmounts } from './quickCash'

describe('quickCashAmounts', () => {
  it('dedupes the 50k and 100k rules when they agree', () => {
    expect(quickCashAmounts(1_251_000)).toEqual([1_251_000, 1_300_000, 1_500_000])
  })
  it('offers every step for a small total', () => {
    expect(quickCashAmounts(49_000)).toEqual([49_000, 50_000, 100_000, 500_000, 1_000_000])
  })
  it('goes strictly above an exact multiple', () => {
    expect(quickCashAmounts(1_000_000)).toEqual([1_000_000, 1_050_000, 1_100_000, 1_500_000])
  })
  it('does not add 1 000 000 at or below the total', () => {
    expect(quickCashAmounts(2_300_000)).toEqual([2_300_000, 2_350_000, 2_400_000, 2_500_000])
  })
  it('never exceeds five entries and keeps the exact total first', () => {
    for (const t of [1, 10_000, 99_999, 450_000, 999_999]) {
      const r = quickCashAmounts(t)
      expect(r.length).toBeLessThanOrEqual(5)
      expect(r[0]).toBe(t)
    }
  })
})
