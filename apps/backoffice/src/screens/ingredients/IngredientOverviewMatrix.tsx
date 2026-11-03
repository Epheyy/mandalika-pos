import { useMemo } from 'react'
import type { InventoryOverviewLocation } from '@mandalika/api'
import { FlaskConical, Store, Warehouse as WarehouseIcon } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { IngredientLocationStockView } from './IngredientLocationStockView'
import { useListState } from '../../lib/router/useListState'
import { useRoute } from '../../lib/router/useRoute'
import { backOrNavigate, navigate } from '../../lib/router/navigate'
import { FilterBar } from '../../ui/FilterBar'
import {
  OVERVIEW_SCHEMA,
  kindFilterCode,
  kindFilterOf,
  locationFromPath,
  locationHash,
  overviewPageOf,
  overviewSizeOf,
} from '../inventory/overviewRoute'

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
    <button type="button"
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

  // Search, location type, page and page size are in the URL; so is the location opened from a column header.
  const [state, setState] = useListState(OVERVIEW_SCHEMA)
  const search = state.q
  const kindFilter = kindFilterOf(state.jenis)
  const pageSize = overviewSizeOf(state.per)
  const route = useRoute()
  const picked = locationFromPath(route.path, ['inventori', 'bahan'], 1)
  const selectedLoc = useMemo(() => {
    const hit = picked && data ? data.locations.find((l) => l.kind === picked.kind && l.id === picked.id) : undefined
    return hit ? { kind: hit.kind, id: hit.id, name: hit.name } : null
  }, [picked?.kind, picked?.id, data]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // A page past the end (a stale link) shows the last one.
  const page = Math.min(overviewPageOf(state.hal), totalPages)
  const visibleRows = filteredRows.slice((page - 1) * pageSize, page * pageSize)

  // Drill-in: one location's stock, opened from a column header. "Kembali" steps back to the matrix as it was.
  if (picked && !data && q.loading) return <TableSkeleton />
  if (selectedLoc) {
    const toMatrix = () => void backOrNavigate('#/inventori/bahan', (path) => path[0] === 'inventori' && path[1] === 'bahan' && locationFromPath(path, ['inventori', 'bahan'], 1) === null)
    return <IngredientLocationStockView location={selectedLoc} onBack={toMatrix} />
  }

  const handleKindChange = (k: KindFilter) => setState({ jenis: kindFilterCode(k), hal: 1 })

  const handleSearch = (v: string) => setState({ q: v, hal: 1 }, { replace: true })

  const handlePageSizeChange = (s: number) => setState({ per: s, hal: 1 })

  return (
    <div className="space-y-3">
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Location-type toggle */}
        <div className="flex rounded-xl border border-gray-200 overflow-hidden">
          {KIND_OPTIONS.map((opt) => (
            <button type="button"
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

        <FilterBar.Search label="Cari bahan" placeholder="Cari bahan…" value={search} onChange={handleSearch} />
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
                          void navigate(locationHash(['inventori', 'bahan', 'ikhtisar'], { kind: loc.kind, id: loc.id }))
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
          onChange={(hal) => setState({ hal })}
          pageSize={pageSize}
          onPageSizeChange={handlePageSizeChange}
          className=" mt-1"
        />
      )}
    </div>
  )
}
