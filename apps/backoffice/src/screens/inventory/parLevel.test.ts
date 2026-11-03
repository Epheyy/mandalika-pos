import { describe, expect, it } from 'vitest'
import { parChanged, parseParInput } from './parLevel'

describe('parseParInput', () => {
  it('reads empty as clearing the PAR', () => {
    expect(parseParInput('')).toEqual({ ok: true, value: null })
    expect(parseParInput('  ')).toEqual({ ok: true, value: null })
  })

  it('reads a whole number from zero up', () => {
    expect(parseParInput('0')).toEqual({ ok: true, value: 0 })
    expect(parseParInput('12')).toEqual({ ok: true, value: 12 })
    expect(parseParInput(' 7 ')).toEqual({ ok: true, value: 7 })
  })

  it('refuses a negative, fractional or non-numeric value', () => {
    for (const raw of ['-1', '1.5', 'abc', '1e', 'NaN']) expect(parseParInput(raw)).toEqual({ ok: false })
  })
})

describe('parChanged', () => {
  it('is false when the value is what is stored', () => {
    expect(parChanged(5, 5)).toBe(false)
    expect(parChanged(null, null)).toBe(false)
    expect(parChanged(null, undefined)).toBe(false)
  })

  it('is true for a real change, a clear and a first value', () => {
    expect(parChanged(6, 5)).toBe(true)
    expect(parChanged(null, 5)).toBe(true)
    expect(parChanged(0, null)).toBe(true)
    expect(parChanged(0, undefined)).toBe(true)
  })
})
