import { describe, expect, it } from 'vitest'
import { REASON_FILTERS, isStale, payloadSummary, reasonLabel, shouldStepBack, typeLabel } from './reviewLabels'

describe('reviewLabels', () => {
  it('maps reason codes to plain Indonesian', () => {
    expect(reasonLabel('forbidden')).toBe('Ditolak: tidak berwenang / PIN salah')
    expect(reasonLabel('actor_mismatch')).toBe('Dibuat oleh akun lain')
    expect(reasonLabel('competing_receipt')).toBe('Transfer sudah diterima tablet lain')
    expect(reasonLabel('conflict')).toBe('Ditolak server')
    expect(reasonLabel('offline_expired')).toBe('Offline lebih dari 12 jam')
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

describe('shouldStepBack', () => {
  const base = { loading: false, error: null, rowCount: 0, page: 2 }
  it('steps back only for an empty, settled, error-free page past the first', () => {
    expect(shouldStepBack(base)).toBe(true)
    expect(shouldStepBack({ ...base, page: 1 })).toBe(false)
    expect(shouldStepBack({ ...base, loading: true })).toBe(false)
    expect(shouldStepBack({ ...base, error: 'gagal' })).toBe(false)
    expect(shouldStepBack({ ...base, rowCount: 3 })).toBe(false)
  })
  it('offers offline_expired as a review filter', () => {
    expect(REASON_FILTERS).toContainEqual({ id: 'offline_expired', label: 'Offline lebih dari 12 jam' })
  })
})
