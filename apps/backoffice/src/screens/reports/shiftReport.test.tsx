import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shift } from '@mandalika/api'
import { SNAPSHOT_PENDING_HINT, SNAPSHOT_PENDING_LABEL } from './shiftFlags'
import { shiftColumns, shiftCsvRow, summarizeShifts } from './shiftReport'

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
  it('keeps column names and order', () => {
    expect(Object.keys(shiftCsvRow(closed, outletName))).toEqual([
      'Kasir', 'Outlet', 'Dibuka', 'Ditutup', 'Status', 'Kas Awal', 'Kas Akhir', 'Total Penjualan', 'Refund penjualan shift',
      'Refund dibayar (Tunai)', 'Jumlah Transaksi', 'Tunai', 'Kartu', 'Transfer', 'QRIS',
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
