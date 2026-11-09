import type { ReactNode } from 'react'
import type { Shift } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { BRAND } from '../../lib/brand'
import type { Column } from '../../ui/DataTable'
import { csvDateTime } from '../orderTimes'
import { CASH_REFUNDS_PAID_HEADER, cashRefundsPaidCell } from '../refundDisplay'
import { NEGATIVE_STARTING_CASH_HINT, SNAPSHOT_PENDING_HINT, SNAPSHOT_PENDING_LABEL, isSnapshotPending, startingCashBadge } from './shiftFlags'

const money = (n: number) => BRAND.currency.format(n)
const whenShort = (iso: string | null | undefined) => (iso ? format(parseISO(iso), 'dd MMM HH:mm', { locale: idLocale }) : '-')

export const REFUND_SHIFT_LABEL = 'Refund penjualan shift'
export const REFUND_SHIFT_HINT = 'Mengikuti shift yang membuat penjualan. Tab Unduh data menghitung refund pada hari refund, jadi angkanya bisa berbeda.'

/** A close-time snapshot cell: "Belum dihitung" for an open shift, else the closed-shift cell. */
function snapshotCell(s: Shift, closed: () => ReactNode): ReactNode {
  if (!isSnapshotPending(s)) return closed()
  return (
    <span className="text-xs text-ink-500" title={SNAPSHOT_PENDING_HINT}>
      {SNAPSHOT_PENDING_LABEL}
    </span>
  )
}

export function shiftColumns(outletName: (id: string) => string): Column<Shift>[] {
  return [
    {
      id: 'kasir',
      header: 'Kasir',
      cell: (s) => {
        const badge = startingCashBadge(s)
        return (
          <span className="font-bold">
            {s.cashierName}
            {badge && <span className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-bold text-danger" title={`${NEGATIVE_STARTING_CASH_HINT} Kas awal: ${money(s.startingCash)}`}>{badge}</span>}
          </span>
        )
      },
    },
    { id: 'outlet', header: 'Outlet', cell: (s) => outletName(s.outletId) },
    { id: 'dibuka', header: 'Dibuka', cell: (s) => <span className="whitespace-nowrap text-xs">{whenShort(s.openedAt)}</span> },
    {
      id: 'ditutup',
      header: 'Ditutup',
      cell: (s) => (s.closedAt ? <span className="whitespace-nowrap text-xs">{whenShort(s.closedAt)}</span> : <span className="text-xs font-bold text-ok">Buka</span>),
    },
    { id: 'transaksi', header: 'Transaksi', align: 'right', cell: (s) => snapshotCell(s, () => <span className="font-bold">{s.totalOrders}</span>) },
    { id: 'refund', header: REFUND_SHIFT_LABEL, align: 'right', cell: (s) => snapshotCell(s, () => <span className="font-bold text-danger" title={REFUND_SHIFT_HINT}>{money(s.totalRefunds || 0)}</span>) },
    { id: 'refund-tunai', header: CASH_REFUNDS_PAID_HEADER, align: 'right', cell: (s) => <span className="text-xs">{cashRefundsPaidCell(s, money)}</span> },
    { id: 'penjualan', header: 'Penjualan', align: 'right', cell: (s) => snapshotCell(s, () => <span className="font-black">{money(s.totalSales)}</span>) },
    { id: 'tunai', header: 'Tunai', align: 'right', cell: (s) => snapshotCell(s, () => <span className="text-xs">{money(s.cashSales)}</span>) },
    { id: 'qris', header: 'QRIS', align: 'right', cell: (s) => snapshotCell(s, () => <span className="text-xs">{money(s.qrisSales)}</span>) },
    { id: 'transfer', header: 'Transfer', align: 'right', cell: (s) => snapshotCell(s, () => <span className="text-xs">{money(s.transferSales)}</span>) },
    { id: 'kartu', header: 'Kartu', align: 'right', cell: (s) => snapshotCell(s, () => <span className="text-xs">{money(s.cardSales)}</span>) },
  ]
}

export interface ShiftSummary {
  /** Sums over closed shifts only. */
  totalSales: number
  totalOrders: number
  totalRefunds: number
  /** Every shift in the range, open or closed. */
  shiftCount: number
  /** Shifts whose totals are not computed yet. */
  openCount: number
}

export function summarizeShifts(shifts: readonly Shift[]): ShiftSummary {
  const closed = shifts.filter((s) => !isSnapshotPending(s))
  return {
    totalSales: closed.reduce((n, s) => n + s.totalSales, 0),
    totalOrders: closed.reduce((n, s) => n + s.totalOrders, 0),
    totalRefunds: closed.reduce((n, s) => n + (s.totalRefunds || 0), 0),
    shiftCount: shifts.length,
    openCount: shifts.length - closed.length,
  }
}

/** One CSV row. Open shifts get "Belum dihitung" in the snapshot columns; closed rows stay numeric. */
export function shiftCsvRow(s: Shift, outletName: (id: string) => string): Record<string, string | number> {
  const pending = isSnapshotPending(s)
  const snap = (n: number) => (pending ? SNAPSHOT_PENDING_LABEL : n)
  return {
    Kasir: s.cashierName,
    Outlet: outletName(s.outletId),
    Dibuka: csvDateTime(s.openedAt) || '-',
    Ditutup: csvDateTime(s.closedAt) || '-',
    Status: s.status,
    'Kas Awal': s.startingCash,
    'Kas Akhir': snap(s.closingCash || 0),
    'Total Penjualan': snap(s.totalSales),
    [REFUND_SHIFT_LABEL]: snap(s.totalRefunds || 0),
    [CASH_REFUNDS_PAID_HEADER]: cashRefundsPaidCell(s),
    'Jumlah Transaksi': snap(s.totalOrders),
    Tunai: snap(s.cashSales),
    Kartu: snap(s.cardSales),
    Transfer: snap(s.transferSales),
    QRIS: snap(s.qrisSales),
  }
}
