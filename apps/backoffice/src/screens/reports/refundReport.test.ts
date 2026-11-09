import { describe, expect, it } from 'vitest'
import type { RefundReportRow } from '@mandalika/api'
import { buildCSV } from '../../lib/csvUtils'
import {
  claimedIfDifferent, flagLabel, flagTone, itemSummary, refundCsvRows, scopeLabel, totalQuantity,
} from './refundReport'

const row = (over: Partial<RefundReportRow> = {}): RefundReportRow => ({
  id: 'r1', orderId: 'o1', orderNumber: 'ORD-1', outletId: 'ou1', outletName: 'BSD', cashierName: 'Sari',
  seq: 1, scope: 'partial', amount: 50000, computedAmount: 50000, paymentMethod: 'cash', reason: 'rusak',
  refundedAt: '2026-03-02T05:00:00Z', refundBusinessDate: '2026-03-02',
  items: [{ orderItemId: 'i1', lineNo: 1, productName: 'Oud', variantSize: '30ml', quantity: 2, amount: 50000 }],
  ...over,
})

describe('labels', () => {
  it('labels scopes', () => {
    expect(scopeLabel('full')).toBe('Penuh')
    expect(scopeLabel('partial')).toBe('Sebagian')
    expect(scopeLabel('legacy_full')).toBe('Penuh (lama)')
  })
  it('labels flags and tones', () => {
    expect(flagLabel('amount_mismatch')).toBe('Jumlah beda')
    expect(flagLabel('over_total')).toBe('Melebihi total')
    expect(flagLabel(null)).toBe('')
    expect(flagTone('over_total')).toBe('danger')
    expect(flagTone('amount_mismatch')).toBe('warning')
    expect(flagTone(undefined)).toBe('neutral')
  })
})

describe('itemSummary', () => {
  it('joins multi-line items with size and quantity', () => {
    const items = [
      { orderItemId: 'a', productName: 'Oud', variantSize: '30ml', quantity: 2, amount: 1 },
      { orderItemId: 'b', productName: 'Musk', variantSize: '', quantity: 1, amount: 1 },
    ]
    expect(itemSummary(items)).toBe('Oud (30ml) ×2, Musk ×1')
    expect(totalQuantity(items)).toBe(3)
  })
  it('is empty for no items', () => expect(itemSummary([])).toBe(''))
})

describe('claimedIfDifferent', () => {
  it('shows the claim only when it differs from the amount of record', () => {
    expect(claimedIfDifferent(row({ claimedAmount: 80000 }))).toBe(80000)
    expect(claimedIfDifferent(row({ claimedAmount: 50000 }))).toBeNull()
    expect(claimedIfDifferent(row({ claimedAmount: null }))).toBeNull()
    expect(claimedIfDifferent(row())).toBeNull()
  })
})

describe('refundCsvRows time', () => {
  it('writes Waktu as yyyy-MM-dd HH:mm', () => {
    const local = new Date(2026, 10, 9, 21, 41).toISOString()
    expect(refundCsvRows([row({ refundedAt: local })])[0].Waktu).toBe('2026-11-09 21:41')
  })
})

describe('refundCsvRows', () => {
  it('builds one row per refund', () => {
    const [r] = refundCsvRows([row({ refundedByName: 'Admin', reasonCode: 'damaged' })])
    expect(r).toMatchObject({
      'No. struk': 'ORD-1', 'Refund ke-': 1, Item: 'Oud (30ml) ×2', Qty: 2, Jumlah: 50000,
      'Jumlah diklaim': '', Oleh: 'Admin', Kasir: 'Sari', Outlet: 'BSD', 'Kode alasan': 'damaged',
      'Peringatan jumlah': '', 'Hari refund': '2026-03-02',
    })
  })
  it('carries the claim and flag when they differ', () => {
    const [r] = refundCsvRows([row({ claimedAmount: 90000, amountWarning: 'over_total' })])
    expect(r['Jumlah diklaim']).toBe(90000)
    expect(r['Peringatan jumlah']).toBe('Melebihi total')
  })
  it('handles legacy_full without items or actor', () => {
    const [r] = refundCsvRows([row({ scope: 'legacy_full', items: [], refundBusinessDate: null })])
    expect(r).toMatchObject({ Item: '', Qty: '', Oleh: '', 'Hari refund': '' })
  })
  it('keeps CSV-injection protection and quote escaping', () => {
    const csv = buildCSV(refundCsvRows([row({ reason: '=HYPERLINK("x")', cashierName: 'A, B' })]))
    expect(csv).toContain('"\'=HYPERLINK(""x"")"')
    expect(csv).toContain('"A, B"')
  })
})
