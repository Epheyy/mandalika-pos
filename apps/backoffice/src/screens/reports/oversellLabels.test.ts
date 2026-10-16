import { describe, expect, it } from 'vitest'
import type { OversellRecord, OversellReport } from '@mandalika/api'
import {
  EXPORT_MAX_ROWS,
  collectOversellForExport,
  kindLabel,
  oversellCsvRows,
  syncLagLabel,
} from './oversellLabels'
import { csvCell } from '../../lib/csvUtils'

function record(over: Partial<OversellRecord> = {}): OversellRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001', orderId: '00000000-0000-4000-8000-000000000002',
    orderNumber: 'MND-000001', orderStatus: 'completed',
    outletId: '00000000-0000-4000-8000-000000000003', outletName: 'Outlet A',
    productId: '00000000-0000-4000-8000-000000000004', productName: 'Melati', variantSize: '110ml',
    kind: 'shortage', quantity: 3, stockBefore: 1, stockAfter: -2, shortfall: 2, currentStock: -2,
    channel: 'sync', cashierId: '00000000-0000-4000-8000-000000000005', cashierName: 'Ayu',
    soldAt: '2026-10-01T03:00:00Z', recordedAt: '2026-10-01T05:30:00Z',
    ...over,
  }
}

describe('oversell labels', () => {
  it('names every kind in Indonesian and passes an unknown kind through', () => {
    expect(kindLabel('shortage')).toBe('Stok kurang')
    expect(kindLabel('unresolved_variant')).toBe('Varian tidak ditemukan')
    expect(kindLabel('refund_unresolved_variant')).toBe('Refund varian dihapus')
    expect(kindLabel('future_kind')).toBe('future_kind')
  })

  it('shows the sync lag between sale and server apply', () => {
    expect(syncLagLabel('2026-10-01T03:00:00Z', '2026-10-01T03:00:20Z')).toBe('—')
    expect(syncLagLabel('2026-10-01T03:00:00Z', '2026-10-01T03:25:00Z')).toBe('25 mnt')
    expect(syncLagLabel('2026-10-01T03:00:00Z', '2026-10-01T05:30:00Z')).toBe('3 jam')
    expect(syncLagLabel('2026-10-01T03:00:00Z', '2026-10-04T03:00:00Z')).toBe('3 hari')
    expect(syncLagLabel('not a date', '2026-10-04T03:00:00Z')).toBe('—')
  })
})

describe('oversell CSV rows', () => {
  it('keeps negative stock numeric and renders blanks for the unresolved kinds', () => {
    const [short, unresolved] = oversellCsvRows([
      record(),
      record({ kind: 'unresolved_variant', stockBefore: null, stockAfter: null, currentStock: null, shortfall: 3 }),
    ])
    expect(short['Stok Sesudah']).toBe(-2)
    expect(typeof short['Stok Sesudah']).toBe('number')
    expect(short.Kekurangan).toBe(2)
    expect(unresolved['Stok Sebelum']).toBe('')
    expect(Object.keys(short)).toContain('No. Transaksi')
  })

  it('a hostile product or note cell is neutralised by csvCell, a negative number is not', () => {
    const [row] = oversellCsvRows([record({ productName: '=HYPERLINK("http://x")', acknowledgeNote: '-1+1', acknowledgedAt: '2026-10-02T00:00:00Z' })])
    expect(csvCell(row.Produk).startsWith('"\'=')).toBe(true)
    expect(csvCell(row.Catatan)).toBe("'-1+1")
    expect(csvCell(row['Stok Sesudah'])).toBe('-2')
  })
})

describe('collectOversellForExport', () => {
  const page = (rows: number, total: number): OversellReport => ({
    summary: { lines: total, orders: total, totalShortfall: total, activeShortfall: total, reversedShortfall: 0, openCount: total, byProduct: [], byCashier: [] },
    data: Array.from({ length: rows }, () => record()),
    meta: { total, page: 1, limit: 200 },
  })

  it('stops when everything is fetched', async () => {
    const calls: number[] = []
    const out = await collectOversellForExport(async (p) => {
      calls.push(p)
      return p === 1 ? page(200, 250) : page(50, 250)
    })
    expect(calls).toEqual([1, 2])
    expect(out).toMatchObject({ truncated: false })
    expect(out.rows).toHaveLength(250)
  })

  it('caps at the row limit and says so', async () => {
    const out = await collectOversellForExport(async () => page(200, 9000))
    expect(out.truncated).toBe(true)
    expect(out.rows).toHaveLength(EXPORT_MAX_ROWS)
  })

  it('an empty report is not truncated', async () => {
    const out = await collectOversellForExport(async () => page(0, 0))
    expect(out).toEqual({ rows: [], truncated: false })
  })
})
