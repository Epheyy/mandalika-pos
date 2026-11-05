import { useMemo } from 'react'
import type { InventoryOverviewLocation, InventoryOverviewRow } from '@mandalika/api'
import { Package, Store, Warehouse as WarehouseIcon } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { LocationStockView } from './LocationStockView'
import { visibleTotal } from '../../lib/matrixTotals'
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
    <Store className="w-3.5 h-3.5 text-gold-600 flex-shrink-0" aria-hidden="true" />
  ) : (
    <WarehouseIcon className="w-3.5 h-3.5 text-gold-600 flex-shrink-0" aria-hidden="true" />
  )
}

const VARIANT_COL_WIDTH = 280

/** The matrix columns: the sticky variant, one stock column per shown location, then the total. */
function matrixColumns(locations: readonly InventoryOverviewLocation[], allLocationCount: number): Column<InventoryOverviewRow>[] {
  const locationIds = locations.map((l) => l.id)
  // A kind filter hides columns; the Total then sums what is shown and the server total (every location) moves to a sub-label.
  const filtered = locations.length < allLocationCount
  return [
    {
      id: 'variant',
      header: 'Varian',
      sticky: true,
      width: VARIANT_COL_WIDTH,
      cell: (row) => (
        <span className="font-bold text-sm whitespace-nowrap">
          {row.productName} <span className="font-normal text-gray-500">{row.variantSize}</span>
          {row.sku && <span className="ml-1 font-mono text-xs text-gray-400">· {row.sku}</span>}
        </span>
      ),
    },
    ...locations.map((loc): Column<InventoryOverviewRow> => ({
      id: `loc-${loc.id}`,
      header: loc.name,
      align: 'right',
      cell: (row) => {
        const cell = row.cells.find((c) => c.locationId === loc.id)
        return <span className={cell?.belowPar === true ? 'font-bold text-red-600' : 'text-gray-700'}>{cell?.stock ?? 0}</span>
      },
    })),
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      cell: (row) => (
        <span className="font-bold text-gray-900">
          {filtered ? visibleTotal(row.cells, locationIds, (c) => c.stock) : row.total}
          {filtered && <span className="block text-[11px] font-normal text-gray-400">Semua lokasi: {row.total}</span>}
        </span>
      ),
    },
  ]
}

export function OverviewMatrix() {
  const q = usePolledQuery(() => api.getInventoryOverview(), [])
  const data = q.data

  // Search, location type, page and page size are in the URL; so is the location opened from a column header.
  const [state, setState] = useListState(OVERVIEW_SCHEMA)
  const search = state.q
  const kindFilter = kindFilterOf(state.jenis)
  const pageSize = overviewSizeOf(state.per)
  const route = useRoute()
  const picked = locationFromPath(route.path, ['inventori', 'stok'])
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
        r.productName.toLowerCase().includes(q) ||
        (r.sku ?? '').toLowerCase().includes(q) ||
        (r.variantSize ?? '').toLowerCase().includes(q),
    )
  }, [data, search])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  // A page past the end (a stale link) shows the last one.
  const page = Math.min(overviewPageOf(state.hal), totalPages)
  const visibleRows = filteredRows.slice((page - 1) * pageSize, page * pageSize)

  // Drill-in: one location's stock, opened from a column header. "Kembali" steps back to the matrix as it was.
  if (picked && !data && q.loading) return <TableSkeleton />
  if (selectedLoc) {
    const toMatrix = () => void backOrNavigate('#/inventori/stok', (path) => path[0] === 'inventori' && path[1] === 'stok' && locationFromPath(path, ['inventori', 'stok']) === null)
    return <LocationStockView location={selectedLoc} onBack={toMatrix} />
  }

  const handleKindChange = (k: KindFilter) => setState({ jenis: kindFilterCode(k), hal: 1 })

  const handleSearch = (v: string) => setState({ q: v, hal: 1 }, { replace: true })

  const handlePageSizeChange = (s: number) => setState({ per: s, hal: 1 })

  return (
    <div className="space-y-3">
      <FilterBar
        onReset={() => setState({ q: '', jenis: 'outlet', hal: 1 })}
        activeCount={[search !== '', kindFilter !== 'outlet'].filter(Boolean).length}
      >
        <FilterBar.Chips
          label="Jenis lokasi"
          items={KIND_OPTIONS}
          value={kindFilter}
          onChange={(k) => handleKindChange(k as KindFilter)}
        />
        <FilterBar.Search label="Cari produk" placeholder="Cari produk…" value={search} onChange={handleSearch} />
      </FilterBar>

      {filteredLocations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Stok per lokasi">
          {filteredLocations.map((loc) => (
            <button
              type="button"
              key={loc.id}
              onClick={() => void navigate(locationHash(['inventori', 'stok'], { kind: loc.kind, id: loc.id }))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
              title={`Lihat stok ${loc.name}`}
            >
              <LocationIcon kind={loc.kind} />
              {loc.name}
            </button>
          ))}
        </div>
      )}

      {data && (data.rows.length === 0 || filteredLocations.length === 0) ? (
        <Card className="overflow-hidden">
          <EmptyState icon={<Package />} title={data.rows.length === 0 ? 'Belum ada data stok' : 'Tidak ada lokasi untuk tipe ini'} />
        </Card>
      ) : (
        <DataTable
          caption="Stok produk per lokasi"
          columns={matrixColumns(filteredLocations, data?.locations.length ?? filteredLocations.length)}
          rows={visibleRows}
          rowKey={(row) => `${row.productId}|${row.variantSize}`}
          loading={q.loading && !data}
          error={q.error ? `Stok produk gagal dimuat: ${q.error}` : null}
          onRetry={() => void q.refetch()}
          empty={<EmptyState icon={<Package />} title="Tidak ada produk yang cocok" />}
          footer={
            data && filteredRows.length > 0 ? (
              <Pagination
                page={page}
                totalPages={totalPages}
                total={filteredRows.length}
                onChange={(hal) => setState({ hal })}
                pageSize={pageSize}
                onPageSizeChange={handlePageSizeChange}
              />
            ) : undefined
          }
        />
      )}
    </div>
  )
}
