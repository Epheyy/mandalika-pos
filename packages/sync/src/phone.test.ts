import { describe, expect, it } from 'vitest'
import vectors from './__fixtures__/phone-vectors.json'
import { normalizePhone } from './phone'

// Shared with the Go twin (backend/internal/phone) and the SQL normalize_phone().
describe('normalizePhone', () => {
  it('has a meaningful vector file', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10)
  })
  for (const v of vectors) {
    it(`normalizes ${JSON.stringify(v.input)} to ${JSON.stringify(v.norm)}`, () => {
      expect(normalizePhone(v.input)).toBe(v.norm)
    })
  }
})

// Behaviour of the key beyond the vectors: all spellings of one Indonesian number collide, and
// foreign numbers keep their own country code.
describe('normalizePhone keys', () => {
  it('collides the Indonesian spellings', () => {
    const keys = ['0812 3456 7890', '62 812 3456 7890', '+62 812-3456-7890', '0062 8123456 7890', '812 3456 7890'].map(normalizePhone)
    expect(new Set(keys)).toEqual(new Set(['081234567890']))
  })
  it.each(['+65 8123 4567', '+61 412 345 678', '+1 (415) 555-2671', '+44 20 7946 0958'])('keeps foreign number %s', (n) => {
    expect(normalizePhone(n)).toBe(n.replace(/[^0-9]/g, ''))
  })
})
