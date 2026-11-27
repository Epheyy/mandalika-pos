import { describe, expect, it } from 'vitest'
import { MAX_DISPLAY_NAME_LENGTH, displayNameError, renameError, renamePayload } from './displayName'

describe('displayNameError', () => {
  it('rejects empty and whitespace-only names', () => {
    expect(displayNameError('')).toBe('Nama wajib diisi.')
    expect(displayNameError('   ')).toBe('Nama wajib diisi.')
  })
  it('accepts a normal name, padded or not', () => {
    expect(displayNameError('Rina')).toBeNull()
    expect(displayNameError('  Rina Putri  ')).toBeNull()
  })
  it('caps the length in characters, not UTF-16 units', () => {
    expect(displayNameError('a'.repeat(MAX_DISPLAY_NAME_LENGTH))).toBeNull()
    expect(displayNameError('a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1))).toMatch(/maksimal/)
    expect(displayNameError('😀'.repeat(MAX_DISPLAY_NAME_LENGTH))).toBeNull()
  })
})

describe('renamePayload', () => {
  it('sends nothing when the name is unchanged, even with stray spaces', () => {
    expect(renamePayload('Rina', 'Rina')).toEqual({})
    expect(renamePayload('Rina', '  Rina ')).toEqual({})
  })
  it('sends the trimmed new name when it changed', () => {
    expect(renamePayload('Rina', '  Rina Putri ')).toEqual({ displayName: 'Rina Putri' })
  })
})

describe('renameError', () => {
  it('ignores an unchanged name, even a legacy blank or over-long one', () => {
    expect(renameError('', '')).toBeNull()
    const long = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 5)
    expect(renameError(long, long)).toBeNull()
  })
  it('validates a changed name', () => {
    expect(renameError('Rina', '  ')).toBe('Nama wajib diisi.')
    expect(renameError('Rina', 'Rina Putri')).toBeNull()
  })
})
