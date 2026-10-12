import { describe, expect, it } from 'vitest'
import { isStale, payloadSummary, reasonLabel, typeLabel } from './reviewLabels'

describe('reviewLabels', () => {
  it('maps reason codes to plain Indonesian', () => {
    expect(reasonLabel('forbidden')).toBe('Ditolak: tidak berwenang / PIN salah')
    expect(reasonLabel('actor_mismatch')).toBe('Dibuat oleh akun lain')
    expect(reasonLabel('competing_receipt')).toBe('Transfer sudah diterima tablet lain')
    expect(reasonLabel('conflict')).toBe('Ditolak server')
    expect(reasonLabel('batch_rejected')).toBe('Kiriman ditolak')
    expect(reasonLabel(null)).toBe('Gagal berulang (versi lama)')
    expect(reasonLabel('weird')).toBe('Ditolak (weird)')
  })
  it('labels item types', () => {
    expect(typeLabel('refund')).toBe('Refund')
    expect(typeLabel('transfer_receive')).toBe('Terima transfer')
    expect(typeLabel('mystery')).toBe('mystery')
  })
  it('flags tablets silent for more than 3 days', () => {
    const now = Date.parse('2026-10-12T00:00:00Z')
    expect(isStale('2026-10-08T23:59:00Z', now)).toBe(true)
    expect(isStale('2026-10-10T00:00:00Z', now)).toBe(false)
  })
  it('summarises a refund and tolerates missing fields', () => {
    const rows = payloadSummary('refund', { orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', reason: 'rusak' })
    expect(rows[0]).toEqual(['Struk', 'BSD-G0007'])
    expect(rows[1][1]).toContain('225.000')
    expect(payloadSummary('order', {})).toEqual([['Struk', '—'], ['Barang', '—'], ['Metode', '—'], ['Dibayar', '—']])
    expect(payloadSummary('unknown', { a: 1 })).toEqual([])
  })
})
