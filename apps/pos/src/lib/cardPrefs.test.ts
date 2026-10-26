import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCardPref } from './cardPrefs'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  }
})
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('readCardPref', () => {
  it('uses the default when the key is missing', () => {
    expect(readCardPref('pos_cardPrice', true)).toBe(true)
    expect(readCardPref('pos_cardVariants', false)).toBe(false)
  })
  it('an explicit 1 is on and an explicit 0 is off, whatever the default', () => {
    store.set('pos_cardPrice', '0')
    store.set('pos_cardVariants', '1')
    expect(readCardPref('pos_cardPrice', true)).toBe(false)
    expect(readCardPref('pos_cardVariants', false)).toBe(true)
  })
  it('falls back to the default when storage throws', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
    }
    expect(readCardPref('pos_cardStock', true)).toBe(true)
  })
})
