import { describe, expect, it } from 'vitest'
import { ApiError } from '@mandalika/api'
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
  it('shows the open-shift refusals verbatim (user edit and delete)', () => {
    const move = 'Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum memindah outlet.'
    const del = 'Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum menghapus.'
    expect(errorText(new ApiError(409, move), 'Gagal menyimpan akses. Coba lagi.')).toBe(move)
    expect(errorText(new ApiError(409, del), 'Gagal menghapus pengguna. Coba lagi.')).toBe(del)
  })
})
