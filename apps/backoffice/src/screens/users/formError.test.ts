import { describe, expect, it } from 'vitest'
import { errorText } from './formError'

describe('errorText', () => {
  it('keeps the server reason', () => {
    expect(errorText(new Error('Role masih dipakai 3 pengguna'), 'Gagal')).toBe('Role masih dipakai 3 pengguna')
  })
  it('falls back for an empty message or a non-error', () => {
    expect(errorText(new Error('  '), 'Gagal')).toBe('Gagal')
    expect(errorText('boom', 'Gagal')).toBe('Gagal')
    expect(errorText(undefined, 'Gagal')).toBe('Gagal')
  })
})
