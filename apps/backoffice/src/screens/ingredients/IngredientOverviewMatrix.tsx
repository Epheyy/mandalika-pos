import { useMemo, useState } from 'react'
import type { InventoryOverviewLocation } from '@mandalika/api'
import { FlaskConical, Search, Store, Warehouse as WarehouseIcon } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Card, EmptyState } from '../../ui'
import { Pagination } from '../../ui/Pagination'
import { IngredientLocationStockView } from './IngredientLocationStockView'

const PAGE_SIZE_DEFAULT = 25

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

type KindFilter = 'outlet' | 'warehouse' | 'semua'

const KIND_OPTIONS: { id: KindFilter; label: string }[] = [
  { id: 'outlet', label: 'Outlet' },
  { id: 'warehouse', label: 'Gudang' },
  { id: 'semua', label: 'Semua' },
]

function LocationIcon({ kind }: { kind: 'outlet' | 'warehouse' }) {
  return kind === 'outlet' ? (
    <Store className="w-3.5 h-3.5 text-gold-600 flex-shrink-0" />
  ) : (
    <WarehouseIcon className="w-3.5 h-3.5 text-gold-600 flex-shrink-0" />
  )
}

function LocationHeaderButton({
  loc,
  onClick,
}: {
  loc: InventoryOverviewLocation
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-100 cursor-pointer transition-colors min-w-[80px]"
      title={`Lihat stok bahan ${loc.name}`}
    >
      <LocationIcon kind={loc.kind} />
      <span className="text-xs font-bold text-gray-700 whitespace-nowrap leading-tight">
        {loc.name}
      </span>
    </button>
  )
}

export function IngredientOverviewMatrix() {
  const q = usePolledQuery(() => api.getIngredientOverview(), [])
  const data = q.data

  const [selectedLoc, setSelectedLoc] = useState<LocationTarget | null>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>('outlet')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  // All hooks must run unconditionally before any early return
  const filteredLocations = useMemo(() => {
    if (!data) return []
    return kindFilter === 'semua'
      ? data.locations
      : data.locations.filter((l) => l.kind === kindFilter)
  }, [data, kindFilter])

  const filteredRows = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    if (!q) return data.rows
    return data.rows.filter(
      (r) =>
        r.ingredientName.toLowerCase().includes(q) ||
        (r.sku ?? '').toLowerCase().includes(q),
    )
  }, [data, search])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const visibleRows = filteredRows.slice((page - 1) * pageSize, page * pageSize)

  // Drill-in: render IngredientLocationStockView when a location column header is clicked
  if (selectedLoc) {
    return (
      <IngredientLocationStockView location={selectedLoc} onBack={() => setSelectedLoc(null)} />
    )
  }

  const handleKindChange = (k: KindFilter) => {
    setKindFilter(k)
    setPage(1)
  }

  const handleSearch = (v: string) => {
    setSearch(v)
    setPage(1)
  }

  const handlePageSizeChange = (s: number) => {
    setPageSize(s)
    setPage(1)
  }

  return (
    <div className="space-y-3">
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Location-type toggle */}
        <div className="flex rounded-xl border border-gray-200 overflow-hidden">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleKindChange(opt.id)}
              className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                kindFilter === opt.id
                  ? 'bg-gold-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Ingredient search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Cari bahan…"
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-gray-200 rounded-xl placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition"
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        {q.loading && !data ? (
          <TableSkeleton />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState icon={<FlaskConical />} title="Belum ada data stok bahan" />
        ) : filteredLocations.length === 0 ? (
          <EmptyState icon={<FlaskConical />} title="Tidak ada lokasi untuk tipe ini" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {/* Sticky first column: Bahan */}
                  <th className="sticky left-0 bg-gray-50 z-10 text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap border-r border-gray-100">
                    Bahan
                  </th>
                  {filteredLocations.map((loc) => (
                    <th
                      key={loc.id}
                      className="px-2 py-2 text-xs font-black text-gray-400 uppercase tracking-wider text-center"
                    >
                      <LocationHeaderButton
                        loc={loc}
                        onClick={() =>
                          setSelectedLoc({ kind: loc.kind, id: loc.id, name: loc.name })
                        }
                      />
                    </th>
                  ))}
                  {/* Sticky Total column */}
                  <th className="sticky right-0 bg-gray-50 z-10 px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider text-right whitespace-nowrap border-l border-gray-200">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {visibleRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={filteredLocations.length + 2}
                      className="px-5 py-8 text-center text-sm text-gray-400"
                    >
                      Tidak ada bahan yang cocok
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((row) => (
                    <tr key={row.ingredientId} className="hover:bg-gray-50">
                      {/* Sticky first column */}
                      <td className="sticky left-0 bg-white z-10 px-5 py-3 font-bold text-gray-900 text-sm whitespace-nowrap border-r border-gray-100">
                        {row.ingredientName}{' '}
                        <span className="font-normal text-gray-500">{row.unit}</span>
                        {row.sku && (
                          <span className="ml-1 font-mono text-xs text-gray-400">· {row.sku}</span>
                        )}
                      </td>
                      {filteredLocations.map((loc) => {
                        const cell = row.cells.find((c) => c.locationId === loc.id)
                        const qty = cell?.qty ?? 0
                        return (
                          <td
                            key={loc.id}
                            className="px-4 py-3 text-center text-sm text-gray-700"
                          >
                            {qty.toFixed(3)}
                          </td>
                        )
                      })}
                      {/* Sticky Total */}
                      <td className="sticky right-0 bg-white z-10 px-4 py-3 text-right font-bold text-gray-900 text-sm border-l border-gray-200">
                        {row.total.toFixed(3)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data && filteredRows.length > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          total={filteredRows.length}
          onChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={handlePageSizeChange}
          className=" mt-1"
        />
      )}
    </div>
  )
}
