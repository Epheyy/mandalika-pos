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
