import { describe, expect, it } from 'vitest'
import { errorMessageText } from './errorMessage'

describe('errorMessageText', () => {
  it.each([
    ['order rejected', 'order', 'Transaksi ditolak server'],
    ['Failed to fetch', 'order', 'Koneksi ke server terputus'],
    ['HTTP 403 Forbidden', undefined, 'Tidak punya izin untuk tindakan ini'],
    ['HTTP 500', 'panic', 'Terjadi kesalahan di server'],
    ['printer bluetooth disconnected', 'receipt', 'Pencetakan gagal'],
  ])('maps %s to Indonesian', (msg, kind, expected) => {
    expect(errorMessageText(msg, kind).summary).toBe(expected)
  })

  it('classifies panics and printer faults by kind and source, not text', () => {
    expect(errorMessageText('runtime error: invalid memory address or nil pointer dereference', 'panic').summary).toBe('Terjadi kesalahan di server')
    expect(errorMessageText('Connection timeout', 'receipt', 'print').summary).toBe('Pencetakan gagal')
  })

  it('keeps the raw text for Detail teknis', () => {
    expect(errorMessageText('order rejected', 'order').raw).toBe('order rejected')
  })

  it('falls back to the kind label, never the raw text', () => {
    const r = errorMessageText('xyz weird', 'refund')
    expect(r.summary).toBe('Refund gagal')
    expect(r.summary).not.toContain('xyz')
  })

  it('does not blame the server for client crashes or use word fragments', () => {
    expect(errorMessageText('Promise rejected: x', 'unhandledrejection').summary).toBe('Error aplikasi')
    expect(errorMessageText('RangeError: Invalid time value', 'uncaught').summary).toBe('Error aplikasi')
    expect(errorMessageText('fingerprint BSD-500', 'order').summary).toBe('Penjualan gagal')
  })

  it('does not double the failure word for descriptive kinds', () => {
    expect(errorMessageText('zzz', 'outbox_write').summary).toBe('Transaksi gagal disimpan di tablet')
  })

  it('falls back to a generic line for an unknown kind or empty message', () => {
    expect(errorMessageText('', 'nope').summary).toBe('Terjadi kesalahan')
    expect(errorMessageText(null).raw).toBe('')
  })
})
