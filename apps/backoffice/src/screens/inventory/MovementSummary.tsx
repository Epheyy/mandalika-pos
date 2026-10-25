import { useState } from 'react'
import type { MovementLedgerSummaryResponse, MovementLedgerSummaryRow } from '@mandalika/api'
import { BarChart2 } from 'lucide-react'
import { api } from '../../api'
import { localDay } from '../../lib/businessDay'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Select, fieldClass } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { MOVEMENT_KIND_LABEL, daysAgoDay, type MovementKind } from './stockCardFormat'
import type { StockCardTarget } from './StockCard'
import { useLocations } from './useLocations'

const HEADERS = ['Produk', 'Ukuran', 'SKU', 'Saldo Awal', 'Masuk', 'Keluar', 'Saldo Akhir']

/** "Penjualan 3 · Penerimaan 5" for the per-kind quantities of a summary row. */
function kindBreakdown(byKind: Record<string, number>): string {
  return Object.entries(byKind)
    .filter(([, qty]) => qty > 0)
    .map(([kind, qty]) => `${MOVEMENT_KIND_LABEL[kind as MovementKind] ?? kind} ${qty}`)
    .join(' · ')
}

const sum = (byKind: Record<string, number>): number => Object.values(byKind).reduce((a, b) => a + b, 0)

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
  )

  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

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
          <label htmlFor="movement-summary-from-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Dari</label>
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
          <label htmlFor="movement-summary-to-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Sampai</label>
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
      </div>

      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<BarChart2 />} title="Tidak ada pergerakan stok dalam rentang waktu ini" />
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
                    <td className="px-5 py-3 text-sm text-green-700" title={kindBreakdown(r.inByKind)}>{sum(r.inByKind)}</td>
                    <td className="px-5 py-3 text-sm text-red-600" title={kindBreakdown(r.outByKind)}>{sum(r.outByKind)}</td>
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
