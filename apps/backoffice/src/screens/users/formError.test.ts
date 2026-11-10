import { describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from '@mandalika/api'
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
  it('shows the open-shift refusals verbatim, from the real client (user edit and delete)', async () => {
    const move = 'Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum memindah outlet.'
    const del = 'Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum menghapus.'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const api = createClient({ baseUrl: 'http://x', getToken: () => 't' })
      const conflict = (msg: string) =>
        new Response(JSON.stringify({ data: null, error: msg }), { status: 409, headers: { 'Content-Type': 'application/json' } })
      fetchMock.mockResolvedValueOnce(conflict(move))
      const editErr = await api.updateUser('u1', { outletId: null }).catch((e: unknown) => e)
      expect(editErr).toBeInstanceOf(ApiError)
      expect(errorText(editErr, 'Gagal menyimpan akses. Coba lagi.')).toBe(move)
      fetchMock.mockResolvedValueOnce(conflict(del))
      const delErr = await api.deleteUser('u1').catch((e: unknown) => e)
      expect(errorText(delErr, 'Gagal menghapus pengguna. Coba lagi.')).toBe(del)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
