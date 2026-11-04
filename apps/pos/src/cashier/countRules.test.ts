import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLIND_COUNT_DEFAULT, denominationTotal, isCountRevealed } from './countRules'
import { readCardPref } from '../lib/cardPrefs'

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

describe('blind count default (owner 2026-11-05)', () => {
  const store = new Map<string, string>()
  const stub = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  beforeEach(() => { store.clear(); vi.stubGlobal('localStorage', stub) })
  afterEach(() => vi.unstubAllGlobals())

  it('is ON when never set explicitly', () => {
    expect(BLIND_COUNT_DEFAULT).toBe(true)
    expect(readCardPref('pos_blindCount', BLIND_COUNT_DEFAULT)).toBe(true)
  })
  it('a manager who turned it off keeps it off', () => {
    store.set('pos_blindCount', '0')
    expect(readCardPref('pos_blindCount', BLIND_COUNT_DEFAULT)).toBe(false)
  })
  it('in blind mode nothing is revealed before every count is entered, and recount stays possible', () => {
    expect(isCountRevealed(BLIND_COUNT_DEFAULT, ['cash', 'card'], { cash: 5 })).toBe(false)
    expect(isCountRevealed(BLIND_COUNT_DEFAULT, ['cash', 'card'], { cash: 5, card: 0 })).toBe(true)
    // editing a count back to empty hides the figures again (the panel deletes the key)
    expect(isCountRevealed(BLIND_COUNT_DEFAULT, ['cash', 'card'], { card: 0 })).toBe(false)
  })
})
