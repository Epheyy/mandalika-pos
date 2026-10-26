import { useState } from 'react'
import type { MovementLedgerSummaryResponse, MovementLedgerSummaryRow } from '@mandalika/api'
import { BarChart2, Download } from 'lucide-react'
import { api } from '../../api'
import { localDay } from '../../lib/businessDay'
import { downloadCsvText } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Select, fieldClass } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { daysAgoDay } from './stockCardFormat'
import { BUCKET_COLUMNS, formatSigned } from './pergerakanBuckets'
import type { StockCardTarget } from './StockCard'
import { useLocations } from './useLocations'

// The ledger summary scans a location's history: refresh it slowly (the inputs refetch at once).
const SUMMARY_REFRESH_MS = 60_000

const HEADERS = ['Produk', 'Ukuran', 'SKU', 'Saldo Awal', ...BUCKET_COLUMNS.map((c) => c.label), 'Saldo Akhir']

interface MovementSummaryProps {
  /** Open the kartu stok of a SKU (a row click). */
  onOpenCard: (target: StockCardTarget) => void
}

/** Ringkasan pergerakan per SKU, built on the stock ledger (saldo awal, masuk, keluar, saldo akhir). */
export function MovementSummary({ onOpenCard }: MovementSummaryProps) {
  const loc = useLocations()
  const [fromDay, setFromDay] = useState(() => daysAgoDay(30))
  const [toDay, setToDay] = useState(() => localDay())
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const where = loc.location
  const q = usePolledQuery<MovementLedgerSummaryResponse>(
    () =>
      where
        ? api.getMovementLedgerSummary({
            locationType: where.type,
            locationId: where.id,
            from: fromDay,
            to: toDay,
            q: search.trim() || undefined,
            page,
            limit: pageSize,
          })
        : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: pageSize } }),
    [where?.type, where?.id, fromDay, toDay, search, page, pageSize],
    SUMMARY_REFRESH_MS,
  )

  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const exportCsv = async () => {
    if (!where) return
    setExporting(true)
    setExportError(null)
    try {
      const text = await api.exportMovementLedgerSummary({
        locationType: where.type,
        locationId: where.id,
        from: fromDay,
        to: toDay,
        q: search.trim() || undefined,
      })
      downloadCsvText(text, `pergerakan-stok_${fromDay}_${toDay}.csv`)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Gagal mengunduh CSV')
    } finally {
      setExporting(false)
    }
  }

  const open = (r: MovementLedgerSummaryRow) =>
    onOpenCard({
      locationKey: loc.locationKey,
      productId: r.productId,
      variantSize: r.variantSize,
      label: `${r.productName} · ${r.variantSize}${r.sku ? ` (${r.sku})` : ''}`,
      fromDay,
      toDay,
    })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[220px]">
          <Select
            label="Lokasi"
            value={loc.locationKey}
            onChange={(e) => {
              loc.setLocationKey(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Pilih lokasi...</option>
            <optgroup label="Outlet">
              {loc.outlets.map((o) => (
                <option key={o.id} value={`outlet:${o.id}`}>{o.name}</option>
              ))}
            </optgroup>
            <optgroup label="Gudang">
              {loc.warehouses.map((w) => (
                <option key={w.id} value={`warehouse:${w.id}`}>{w.name}</option>
              ))}
            </optgroup>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="movement-summary-from-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Tanggal tercatat dari</label>
          <input
            id="movement-summary-from-date"
            type="date"
            value={fromDay}
            max={toDay}
            onChange={(e) => {
              setFromDay(e.target.value)
              setPage(1)
            }}
            className={fieldClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="movement-summary-to-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Tanggal tercatat sampai</label>
          <input
            id="movement-summary-to-date"
            type="date"
            value={toDay}
            min={fromDay}
            onChange={(e) => {
              setToDay(e.target.value)
              setPage(1)
            }}
            className={fieldClass}
          />
        </div>

        <div className="flex flex-col gap-1 min-w-[220px]">
          <label htmlFor="movement-summary-q" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Cari</label>
          <input
            id="movement-summary-q"
            value={search}
            placeholder="Nama, SKU, atau barcode"
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className={fieldClass}
          />
        </div>
        <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={exporting} onClick={exportCsv} disabled={!where}>
          Unduh CSV
        </Button>
      </div>

      {exportError && <p role="alert" className="text-sm text-red-600">{exportError}</p>}
      {q.error && <p role="alert" className="text-sm text-red-600">{q.error}</p>}

      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          q.error ? null : <EmptyState icon={<BarChart2 />} title="Tidak ada pergerakan stok dalam rentang waktu ini" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {HEADERS.map((h) => (
                    <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => (
                  <tr
                    key={`${r.productId}|${r.variantSize}`}
                    className="hover:bg-gray-50 cursor-pointer"
                    tabIndex={0}
                    onClick={() => open(r)}
                    onKeyDown={(e) => e.key === 'Enter' && open(r)}
                  >
                    <td className="px-5 py-3 font-bold text-gray-900 text-sm whitespace-nowrap">{r.productName}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{r.variantSize}</td>
                    <td className="px-5 py-3 text-sm text-gray-500 font-mono">{r.sku || '—'}</td>
                    <td className="px-5 py-3 text-sm text-gray-700">{r.opening}</td>
                    {BUCKET_COLUMNS.map((c) => (
                      <td
                        key={c.key}
                        className={`px-5 py-3 text-sm ${r.buckets[c.key] < 0 ? 'text-red-600' : r.buckets[c.key] > 0 ? 'text-green-700' : 'text-gray-400'}`}
                        title={c.key === 'masuk' && r.masukGaransi !== 0 ? `${c.hint}. Di antaranya Garansi: ${r.masukGaransi}` : c.hint}
                      >
                        {formatSigned(r.buckets[c.key])}
                      </td>
                    ))}
                    <td className="px-5 py-3 text-sm font-black text-gray-900">{r.closing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => {
          setPageSize(s)
          setPage(1)
        }}
      />
    </div>
  )
}
