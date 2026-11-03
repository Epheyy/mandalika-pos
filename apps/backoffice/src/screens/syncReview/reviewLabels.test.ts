import { describe, expect, it } from 'vitest'
import { REASON_FILTERS, amountFlagLabel, outletOf, reasonFilterOf, refundReviewLabel, isStale, payloadSummary, reasonLabel, shouldStepBack, typeLabel } from './reviewLabels'

describe('reviewLabels', () => {
  it('maps reason codes to plain Indonesian', () => {
    expect(reasonLabel('forbidden')).toBe('Ditolak: tidak berwenang / PIN salah')
    expect(reasonLabel('actor_mismatch')).toBe('Dibuat oleh akun lain')
    expect(reasonLabel('competing_receipt')).toBe('Transfer sudah diterima tablet lain')
    expect(reasonLabel('conflict')).toBe('Ditolak server')
    expect(reasonLabel('offline_expired')).toBe('Offline lebih dari 12 jam')
    expect(reasonLabel('batch_rejected')).toBe('Kiriman ditolak')
    expect(reasonLabel('sale_in_review')).toBe('Penjualan asal refund sedang ditinjau')
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
    expect(rows[1][1]).toBe('Semua barang (refund seluruhnya)')
    expect(rows[2][1]).toContain('225.000')
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
    expect(REASON_FILTERS).toContainEqual({ id: 'sale_in_review', label: 'Penjualan asal refund sedang ditinjau' })
  })
})

describe('refund review texts', () => {
  const warn = ' Data tetap tersimpan. Jika uang sudah dikembalikan, jangan bayar ulang.'
  it.each([
    ['Jumlah refund melebihi sisa barang yang belum direfund.', 'melebihi sisa barang'],
    ['Sebagian transaksi ini sudah direfund dari tablet lain. Perbarui aplikasi lalu refund sisa barang.', 'perbarui aplikasi'],
    ['Barang promo paket/beli-gratis harus direfund bersamaan seluruhnya.', 'bersamaan seluruhnya'],
    ['Transaksi lama hanya bisa direfund seluruhnya.', 'seluruhnya'],
    ['Baris barang refund tidak dikenal, ganda, atau jumlahnya tidak valid.', 'tidak dikenal'],
    ['Kode alasan refund tidak valid.', 'Kode alasan'],
  ])('labels %s and keeps the do-not-pay-again note', (text, frag) => {
    const label = refundReviewLabel(text + warn)
    expect(label?.toLowerCase()).toContain(frag.toLowerCase())
    expect(label).toContain('jangan bayar ulang')
    expect(refundReviewLabel(text)).not.toContain('jangan bayar ulang')
  })
  it('returns null for unknown or empty text', () => {
    expect(refundReviewLabel('sesuatu lain')).toBeNull()
    expect(refundReviewLabel(null)).toBeNull()
  })
  it('labels the amount flags as information', () => {
    expect(amountFlagLabel('amount_mismatch')).toContain('informasi')
    expect(amountFlagLabel('over_total')).toContain('informasi')
    expect(amountFlagLabel('x')).toBeNull()
  })
  it('summarises per-line refund items and the claimed amount', () => {
    const rows = payloadSummary('refund', { orderNumber: 'A', items: [{ lineNo: 2, quantity: 1, productName: 'Oud' }, { lineNo: 3, quantity: 2 }], refundAmount: 50000, total: 99 })
    expect(rows[1]).toEqual(['Barang', 'Baris 2 (Oud) × 1, Baris 3 × 2'])
    expect(rows[2][0]).toBe('Jumlah diklaim tablet')
    expect(rows[2][1]).toContain('50.000')
  })
})

describe('URL filters', () => {
  it('keeps a known reason and an outlet uuid, and drops anything else', () => {
    expect(reasonFilterOf('forbidden')).toBe('forbidden')
    expect(reasonFilterOf('none')).toBe('none')
    expect(reasonFilterOf('bogus')).toBe('')
    expect(outletOf('3f2a9c1d-1111-4222-8333-444455556666')).toBe('3f2a9c1d-1111-4222-8333-444455556666')
    expect(outletOf('abc')).toBe('')
  })
})
