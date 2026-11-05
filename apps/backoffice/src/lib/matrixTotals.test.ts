import { describe, expect, it } from 'vitest'
import { formatQty, visibleTotal } from './matrixTotals'

describe('visibleTotal', () => {
  const cells = [
    { locationId: 'o1', qty: 5 },
    { locationId: 'w1', qty: 40 },
    { locationId: 'o2', qty: 2 },
  ]
  it('sums only the shown locations', () => {
    expect(visibleTotal(cells, ['o1', 'o2'], (c) => c.qty)).toBe(7)
    expect(visibleTotal(cells, ['w1'], (c) => c.qty)).toBe(40)
  })
  it('is 0 when none are shown', () => {
    expect(visibleTotal(cells, [], (c) => c.qty)).toBe(0)
  })
})

describe('formatQty', () => {
  it('uses comma decimals and trims trailing zeros', () => {
    expect(formatQty(295.5, 'g')).toBe('295,5 g')
    expect(formatQty(295, 'g')).toBe('295 g')
    expect(formatQty(0.125, 'kg')).toBe('0,125 kg')
  })
  it('groups thousands with a dot and omits a missing unit', () => {
    expect(formatQty(12345.678)).toBe('12.345,678')
  })
  it('does not render negative zero', () => {
    expect(formatQty(-0.0001, 'g')).toBe('0 g')
  })
})
