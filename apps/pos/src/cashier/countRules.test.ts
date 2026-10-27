import { describe, expect, it } from 'vitest'
import { denominationTotal, isCountRevealed } from './countRules'

describe('denominationTotal', () => {
  it('multiplies each note by its count and adds the coin amount', () => {
    expect(denominationTotal({ 100000: 2, 50000: 1, 20000: 3, 10000: 0, 5000: 4, 2000: 1, 1000: 7 }, 1500)).toBe(200000 + 50000 + 60000 + 20000 + 2000 + 7000 + 1500)
  })
  it('is zero for nothing counted', () => expect(denominationTotal({}, 0)).toBe(0))
  it('ignores negative, fractional and non-numeric counts', () => {
    expect(denominationTotal({ 100000: -3, 50000: 1.9, 20000: Number.NaN }, -50)).toBe(50000)
  })
})

describe('isCountRevealed', () => {
  const fields = ['cash', 'card']
  it('always reveals when blind count is off', () => expect(isCountRevealed(false, fields, {})).toBe(true))
  it('hides until every field has a value', () => {
    expect(isCountRevealed(true, fields, {})).toBe(false)
    expect(isCountRevealed(true, fields, { cash: 100 })).toBe(false)
  })
  it('reveals together once all are entered, zero included', () => {
    expect(isCountRevealed(true, fields, { cash: 0, card: 0 })).toBe(true)
  })
  it('has nothing to hide when there are no fields (no open shift)', () => expect(isCountRevealed(true, [], {})).toBe(true))
})
