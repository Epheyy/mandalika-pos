import { Package } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { bundleLineText, bundleReportParams, sumBundleRows, type BundleReport, type BundleReportRow } from './bundleReport'

const COLUMNS: Column<BundleReportRow>[] = [
  { id: 'aroma', header: 'Aroma', cell: (r) => <span className="font-bold">{r.productName}</span> },
  { id: 'lini', header: 'Lini', cell: (r) => bundleLineText(r) },
  { id: 'ukuran', header: 'Ukuran', cell: (r) => r.size },
  { id: 'bundle', header: 'Bundle', align: 'right', cell: (r) => r.bundles },
  { id: 'pendapatan', header: 'Pendapatan', align: 'right', cell: (r) => <span className="font-black">{BRAND.currency.format(r.revenue)}</span> },
  { id: 'diskon', header: 'Diskon', align: 'right', cell: (r) => BRAND.currency.format(r.discount) },
]

interface ViewProps {
  report: BundleReport | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
}

/** The table and its totals row; the tab below only fetches. */
export function BundleReportView({ report, loading, error, onRetry }: ViewProps) {
  const rows = report?.data ?? []
  const t = sumBundleRows(rows)
  return (
    <DataTable
      caption="Penjualan bundle"
      columns={COLUMNS}
      rows={rows}
      rowKey={(r) => `${r.productId}|${r.line}|${r.size}`}
      loading={loading && !report}
      error={error ? `Gagal memuat laporan bundle. ${error}` : null}
      onRetry={onRetry}
      empty={<EmptyState icon={<Package />} title="Belum ada bundle terjual pada rentang ini" />}
      footer={rows.length > 0 ? (
        <p data-testid="bundle-totals" className="flex justify-between gap-4 text-sm font-black text-gray-900">
          <span>Total · {t.bundles} bundle</span>
          <span>{BRAND.currency.format(t.revenue)} · diskon {BRAND.currency.format(t.discount)}</span>
        </p>
      ) : undefined}
    />
  )
}

interface BundleReportTabProps {
  dateFrom: string
  dateTo: string
  outletId: string
}

/** Backoffice "Laporan › Bundle": bundles sold per fragrance, line and size for the hub's date range
 * and outlet. Refunded bundles are already left out by the server. */
export function BundleReportTab({ dateFrom, dateTo, outletId }: BundleReportTabProps) {
  const rq = usePolledQuery<BundleReport>(
    () => api.getBundleReport(bundleReportParams(dateFrom, dateTo, outletId)),
    [dateFrom, dateTo, outletId],
  )
  return (
    <div className="space-y-5">
      <BundleReportView report={rq.data} loading={rq.loading} error={rq.error} onRetry={() => void rq.refetch()} />
    </div>
  )
}
