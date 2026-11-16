import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shift } from '@mandalika/api'
import { SNAPSHOT_PENDING_HINT, SNAPSHOT_PENDING_LABEL } from './shiftFlags'
import { csvCell } from '../../lib/csvUtils'
import { correctedCell, shiftColumns, shiftCsvRow, summarizeShifts } from './shiftReport'

const base = {
  id: 's', outletId: 'o1', cashierName: 'Ayu', openedAt: '2026-11-01T02:00:00Z', startingCash: 100000,
  totalSales: 0, totalOrders: 0, totalRefunds: 0, cashSales: 0, cardSales: 0, transferSales: 0, qrisSales: 0,
}
const open = { ...base, status: 'open', closedAt: null, closingCash: null } as unknown as Shift
const closed = {
  ...base, status: 'closed', closedAt: '2026-11-01T10:00:00Z', closingCash: 650000, totalSales: 500000, totalOrders: 7,
  totalRefunds: 25000, cashSales: 300000, cardSales: 50000, transferSales: 100000, qrisSales: 50000,
} as unknown as Shift
const SNAP_COLS = ['transaksi', 'refund', 'penjualan', 'tunai', 'qris', 'transfer', 'kartu']
const outletName = () => 'BSD'

describe('summarizeShifts', () => {
  it('sums closed shifts only, counts every shift and the open ones', () => {
    expect(summarizeShifts([open, closed, closed])).toEqual({ totalSales: 1000000, totalOrders: 14, totalRefunds: 50000, shiftCount: 3, openCount: 1 })
  })
  it('has no open shifts when all are closed', () => {
    expect(summarizeShifts([closed]).openCount).toBe(0)
  })
})

describe('shiftCsvRow', () => {
  it('writes "Belum dihitung" in the snapshot columns of an open shift and keeps the rest', () => {
    const row = shiftCsvRow(open, outletName)
    for (const k of ['Kas Akhir', 'Total Penjualan', 'Refund penjualan shift', 'Jumlah Transaksi', 'Tunai', 'Kartu', 'Transfer', 'QRIS']) {
      expect(row[k]).toBe(SNAPSHOT_PENDING_LABEL)
    }
    expect(row.Status).toBe('open')
    expect(row['Kas Awal']).toBe(100000)
  })
  it('keeps a closed shift numeric', () => {
    const row = shiftCsvRow(closed, outletName)
    expect(row['Kas Akhir']).toBe(650000)
    expect(row['Total Penjualan']).toBe(500000)
    expect(row['Jumlah Transaksi']).toBe(7)
    expect(row.QRIS).toBe(50000)
  })
  it('writes Dibuka/Ditutup as yyyy-MM-dd HH:mm and keeps "-" for a missing Ditutup', () => {
    const local = new Date(2026, 10, 9, 21, 41).toISOString()
    const row = shiftCsvRow({ ...closed, openedAt: local, closedAt: local } as Shift, outletName)
    expect(row.Dibuka).toBe('2026-11-09 21:41')
    expect(row.Ditutup).toBe('2026-11-09 21:41')
    expect(shiftCsvRow(open, outletName).Ditutup).toBe('-')
    expect(csvCell(shiftCsvRow(open, outletName).Ditutup)).toBe('-')
  })
  it('keeps column names and order', () => {
    expect(Object.keys(shiftCsvRow(closed, outletName))).toEqual([
      'Kasir', 'Outlet', 'Dibuka', 'Ditutup', 'Status', 'Kas Awal', 'Kas Akhir', 'Total Penjualan', 'Refund penjualan shift',
      'Refund dibayar (Tunai)', 'Jumlah Transaksi', 'Tunai', 'Kartu', 'Transfer', 'QRIS',
      'Koreksi Total Penjualan', 'Koreksi Jumlah Transaksi', 'Koreksi Tunai', 'Koreksi Kartu', 'Koreksi Transfer', 'Koreksi QRIS',
    ])
  })
})

describe('shiftColumns rendering', () => {
  const cols = shiftColumns(outletName).filter((c) => SNAP_COLS.includes(c.id))
  it('shows "Belum dihitung" with the hint for an open shift', () => {
    expect(cols).toHaveLength(7)
    for (const c of cols) {
      const html = renderToStaticMarkup(<>{c.cell(open)}</>)
      expect(html).toContain(SNAPSHOT_PENDING_LABEL)
      expect(html).toContain(SNAPSHOT_PENDING_HINT)
    }
  })
  it('shows money for a closed shift', () => {
    for (const c of cols) expect(renderToStaticMarkup(<>{c.cell(closed)}</>)).not.toContain(SNAPSHOT_PENDING_LABEL)
    const sales = cols.find((c) => c.id === 'penjualan')!
    expect(renderToStaticMarkup(<>{sales.cell(closed)}</>)).toMatch(/500[.,]000/)
  })
})

describe('corrected closed shift', () => {
  const corrected = {
    ...closed,
    corrections: {
      count: 1,
      byMethod: { cash: -100000 },
      items: [{ voidId: 'v1', orderId: 'o9', orderNumber: 'INV-0009', kind: 'void', method: 'cash', amount: -100000, createdAt: '2026-11-02T01:00:00Z' }],
    },
    correctedTotalSales: 400000, correctedTotalOrders: 6, correctedCashSales: 200000,
    correctedCardSales: 50000, correctedTransferSales: 100000, correctedQrisSales: 50000,
  } as unknown as Shift
  const cols = shiftColumns(outletName)
  const html = (id: string, s: Shift) => renderToStaticMarkup(<>{cols.find((c) => c.id === id)!.cell(s)}</>)

  it('closed corrected shift shows dikoreksi setelah ditutup and Asli → Setelah koreksi', () => {
    expect(html('kasir', corrected)).toContain('dikoreksi setelah ditutup')
    expect(html('penjualan', corrected)).toContain('→')
    expect(html('tunai', corrected)).toContain('→')
    expect(html('qris', corrected)).not.toContain('→')
    expect(html('kasir', closed)).not.toContain('dikoreksi')
    expect(shiftCsvRow(corrected, outletName)['Koreksi Total Penjualan']).toBe(400000)
    expect(shiftCsvRow(corrected, outletName)['Kas Akhir']).toBe(650000)
    expect(shiftCsvRow(closed, outletName)['Koreksi Total Penjualan']).toBe('')
  })
  it('corrections list shows each delta with its order number and signed amount', () => {
    const out = html('kasir', corrected)
    expect(out).toContain('INV-0009')
    expect(out).toContain('Batal')
    expect(out).toContain('\u2212')
    expect(out).toContain('q=INV-0009')
  })
  it('correctedCell shows the plain amount when nothing changed', () => {
    expect(correctedCell(5, undefined)).toBe(correctedCell(5, 5))
  })
})
