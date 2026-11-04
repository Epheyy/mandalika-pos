import { describe, expect, it } from 'vitest'
import emailVectors from '../../types/src/__fixtures__/email-vectors.json'
import { emailProblem, phoneProblem, EMAIL_INVALID_MESSAGE, PHONE_INVALID_MESSAGE, PHONE_REQUIRED_MESSAGE } from '@mandalika/types'

// Twin of backend/internal/custrules (same vectors, same messages).
describe('emailProblem', () => {
  for (const v of emailVectors) {
    it(`${JSON.stringify(v.input)} is ${v.ok ? 'accepted' : 'rejected'}`, () => {
      expect(emailProblem(v.input)).toBe(v.ok ? null : EMAIL_INVALID_MESSAGE)
    })
  }
  it('rejects an over-long email', () => {
    expect(emailProblem('a'.repeat(250) + '@b.co')).toBe(EMAIL_INVALID_MESSAGE)
  })
})

describe('phoneProblem', () => {
  it.each([
    ['', PHONE_REQUIRED_MESSAGE],
    ['   ', PHONE_REQUIRED_MESSAGE],
    ['abc123', PHONE_INVALID_MESSAGE],
    ['12345', PHONE_INVALID_MESSAGE],
    ['0812-3456-7890', null],
    ['+65 8123 4567', null],
    ['+1 (415) 555-2671', null],
  ])('%j -> %j', (input, want) => {
    expect(phoneProblem(input)).toBe(want)
  })
})
