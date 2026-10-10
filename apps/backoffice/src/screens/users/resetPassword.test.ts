import { describe, expect, it } from 'vitest'
import { resetPasswordErrorMessage, validateResetPassword } from './resetPassword'

describe('validateResetPassword', () => {
  it('rejects fewer than 8 characters', () => {
    expect(validateResetPassword('abcdefg', 'abcdefg')).toMatch(/minimal 8/)
    expect(validateResetPassword('', '')).toMatch(/minimal 8/)
  })
  it('accepts exactly 8 and 128 characters', () => {
    expect(validateResetPassword('abcdefgh', 'abcdefgh')).toBeNull()
    const max = 'a'.repeat(128)
    expect(validateResetPassword(max, max)).toBeNull()
  })
  it('rejects more than 128 characters', () => {
    const long = 'a'.repeat(129)
    expect(validateResetPassword(long, long)).toMatch(/maksimal 128/)
  })
  it('counts code points, not UTF-16 units', () => {
    const emoji8 = '😀'.repeat(8) // 16 UTF-16 units, 8 code points
    expect(validateResetPassword(emoji8, emoji8)).toBeNull()
    const emoji7 = '😀'.repeat(7) // 14 units but only 7 code points
    expect(validateResetPassword(emoji7, emoji7)).toMatch(/minimal 8/)
  })
  it('rejects a mismatched confirmation', () => {
    expect(validateResetPassword('abcdefgh', 'abcdefgx')).toMatch(/tidak sama/)
  })
})

describe('resetPasswordErrorMessage', () => {
  it('maps known statuses and falls back for the rest', () => {
    expect(resetPasswordErrorMessage(400)).toMatch(/ditolak/)
    expect(resetPasswordErrorMessage(403)).toMatch(/tidak dapat/)
    expect(resetPasswordErrorMessage(404)).toMatch(/tidak ditemukan/)
    expect(resetPasswordErrorMessage(500)).toMatch(/Gagal/)
    expect(resetPasswordErrorMessage(undefined)).toMatch(/Gagal/)
  })
})
