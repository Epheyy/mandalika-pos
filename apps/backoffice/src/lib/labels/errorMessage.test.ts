import { describe, expect, it } from 'vitest'
import { errorMessageText } from './errorMessage'

describe('errorMessageText', () => {
  it.each([
    ['order rejected', 'order', 'Transaksi ditolak server'],
    ['Failed to fetch', 'order', 'Koneksi ke server terputus'],
    ['HTTP 403 Forbidden', undefined, 'Tidak punya izin untuk tindakan ini'],
    ['status 500', 'panic', 'Terjadi kesalahan di server'],
    ['printer bluetooth disconnected', 'receipt', 'Pencetakan gagal'],
  ])('maps %s to Indonesian', (msg, kind, expected) => {
    expect(errorMessageText(msg, kind).summary).toBe(expected)
  })

  it('keeps the raw text for Detail teknis', () => {
    expect(errorMessageText('order rejected', 'order').raw).toBe('order rejected')
  })

  it('falls back to the kind label, never the raw text', () => {
    const r = errorMessageText('xyz weird', 'refund')
    expect(r.summary).toBe('Refund gagal')
    expect(r.summary).not.toContain('xyz')
  })

  it('falls back to a generic line for an unknown kind or empty message', () => {
    expect(errorMessageText('', 'nope').summary).toBe('Terjadi kesalahan')
    expect(errorMessageText(null).raw).toBe('')
  })
})
