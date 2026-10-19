import { useEffect, useState } from 'react'
import type { Outlet, Warehouse, MovementSummaryResponse } from '@mandalika/api'
import { BarChart2 } from 'lucide-react'
import { api } from '../../api'
import { DEFAULT_TIMEZONE, dayEndIso, dayStartIso, localDay } from '../../lib/businessDay'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Select, fieldClass } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'

// The picked days are calendar days in the LOCATION's zone: an outlet uses its own timezone,
// a warehouse stays on Asia/Jakarta (A28).
function todayDate(): string {
  return localDay()
}

function daysAgoDate(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDay(d)
}

function parseLocationKey(key: string): { kind: 'outlet' | 'warehouse'; id: string } | null {
  const idx = key.indexOf(':')
  if (idx < 0) return null
  return { kind: key.slice(0, idx) as 'outlet' | 'warehouse', id: key.slice(idx + 1) }
}

const HEADERS = [
  'Produk',
  'Ukuran',
  'SKU',
  'Stok Saat Ini',
  'Stok Masuk',
  'Terjual',
  'Refund/Batal',
  'Transfer Masuk',
  'Transfer Keluar',
  'Koreksi',
  'Selisih Opname',
]

export function MovementSummary() {
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const outlets = ouq.data ?? []
  const warehouses = wq.data ?? []

  // Pick the first active outlet as default, then first outlet, then first warehouse.
  const defaultLocationKey = (() => {
    const active = outlets.find((o) => o.isActive)
    if (active) return `outlet:${active.id}`
    if (outlets.length) return `outlet:${outlets[0].id}`
    if (warehouses.length) return `warehouse:${warehouses[0].id}`
    return ''
  })()

  const [locationKey, setLocationKey] = useState('')
  const [fromDate, setFromDate] = useState(() => daysAgoDate(30))
  const [toDate, setToDate] = useState(() => todayDate())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // Once outlets/warehouses load, set the default location if not yet chosen.
  useEffect(() => {
    if (!locationKey && defaultLocationKey) {
      setLocationKey(defaultLocationKey)
    }
  }, [defaultLocationKey, locationKey])

  const parsed = parseLocationKey(locationKey)
  const kind = parsed?.kind ?? 'outlet'
  const locationId = parsed?.id ?? ''

  const locationZone = kind === 'outlet' ? (outlets.find((o) => o.id === locationId)?.timezone ?? DEFAULT_TIMEZONE) : DEFAULT_TIMEZONE
  const fromIso = dayStartIso(fromDate, locationZone)
  const toIso = dayEndIso(toDate, locationZone)

  const q = usePolledQuery<MovementSummaryResponse>(
    () =>
      locationId
        ? api.getMovementSummary({ kind, id: locationId, from: fromIso, to: toIso, page, limit: pageSize })
        : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: pageSize } }),
    [kind, locationId, fromIso, toIso, page, pageSize],
  )

  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const isWarehouse = kind === 'warehouse'


  return (
    <div className="space-y-5">
      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[220px]">
          <Select
            label="Lokasi"
            value={locationKey}
            onChange={(e) => {
              setLocationKey(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Pilih lokasi...</option>
            <optgroup label="Outlet">
              {outlets.map((o) => (
                <option key={o.id} value={`outlet:${o.id}`}>
                  {o.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Gudang">
              {warehouses.map((w) => (
                <option key={w.id} value={`warehouse:${w.id}`}>
                  {w.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="movement-summary-from-date" className="text-xs font-bold text-gray-500 uppercase tracking-wider">Dari</label>
          <input
            id="movement-summary-from-date"
            type="date"
            value={fromDate}
            max={toDate}
            onChange={(e) => {
              setFromDate(e.target.value)
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
            value={toDate}
            min={fromDate}
            onChange={(e) => {
              setToDate(e.target.value)
              setPage(1)
            }}
            className={fieldClass}
          />
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<BarChart2 />}
            title="Tidak ada pergerakan stok dalam rentang waktu ini"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {HEADERS.map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const diffColor =
                    r.opnameDiff > 0
                      ? 'text-green-700'
                      : r.opnameDiff < 0
                        ? 'text-red-600'
                        : 'text-gray-500'

                  return (
                    <tr key={`${r.productId}|${r.variantSize}`} className="hover:bg-gray-50">
                      <td className="px-5 py-3 font-bold text-gray-900 text-sm whitespace-nowrap">
                        {r.productName}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">{r.variantSize}</td>
                      <td className="px-5 py-3 text-sm text-gray-500 font-mono">
                        {r.sku || '—'}
                      </td>
                      <td className="px-5 py-3 text-sm font-black text-gray-900">
                        {r.currentStock}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-700">{r.goodsIn}</td>
                      <td className="px-5 py-3 text-sm text-gray-700">
                        {isWarehouse ? '—' : r.sold}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-700">
                        {isWarehouse ? '—' : r.refunded}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-700">{r.transferIn}</td>
                      <td className="px-5 py-3 text-sm text-gray-700">{r.transferOut}</td>
                      <td className="px-5 py-3 text-sm text-gray-700">{r.adjustmentCount}</td>
                      <td className={`px-5 py-3 text-sm font-bold ${diffColor}`}>
                        {r.opnameDiff > 0 ? `+${r.opnameDiff}` : r.opnameDiff}
                      </td>
                    </tr>
                  )
                })}
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
