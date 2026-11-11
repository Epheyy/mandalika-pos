import { useEffect } from 'react'
import { PackagePlus } from 'lucide-react'
import type { GoodsReceiptListItem, Outlet, Warehouse } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { GOODS_RECEIPT_SOURCE } from '../../lib/labels/goodsReceipt'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { useResetPageOnChange } from '../../lib/useResetPageOnChange'
import { useOutlet } from '../../outlet'
import { pastEndPage } from '../customersPastEnd'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { FilterBar } from '../../ui/FilterBar'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { StatusBadge } from '../../ui/StatusBadge'

interface GoodsReceiptListState {
  lokasi: string
  dari: string
  sampai: string
  q: string
  sumber: string
  hal: number
  per: number
  [key: string]: string | number
}

const LIST_SCHEMA: ListSchema<GoodsReceiptListState> = {
  lokasi: { key: 'lokasi', default: '' },
  dari: { key: 'dari', default: '' },
  sampai: { key: 'sampai', default: '' },
  q: { key: 'q', default: '' },
  sumber: { key: 'sumber', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

const PAGE_SIZES = [25, 50, 100]
// Outlet and warehouse names change rarely: refresh them every 10 minutes, not with the list.
const LOCATION_POLL_MS = 600_000

const SOURCE_OPTIONS = [
  { value: '', label: 'Semua jenis' },
  { value: 'supply', label: GOODS_RECEIPT_SOURCE.supply.label },
  { value: 'warranty', label: GOODS_RECEIPT_SOURCE.warranty.label },
]

const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** "outlet:<id>" or "warehouse:<id>" from the Lokasi select, as the list's two location filters. */
export function locationFilter(key: string): { locationType?: 'outlet' | 'warehouse'; locationId?: string } {
  const [kind, id] = key.split(':')
  return (kind === 'outlet' || kind === 'warehouse') && id ? { locationType: kind, locationId: id } : {}
}

/** Barang Masuk: every goods receipt in the caller's scope, newest first. Read-only; adding one stays on the stock card. */
export function GoodsReceiptsList() {
  const { outletId } = useOutlet()
  const [state, setState] = useListState(LIST_SCHEMA)
  const outletsQ = usePolledQuery<Outlet[]>(() => api.listOutlets(), [], LOCATION_POLL_MS)
  const warehousesQ = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [], LOCATION_POLL_MS)
  const pageSize = PAGE_SIZES.includes(state.per) ? state.per : LIST_SCHEMA.per.default
  const page = Math.max(1, Math.floor(state.hal))

  const q = usePolledQuery(
    () =>
      api.listGoodsReceipts({
        ...locationFilter(state.lokasi),
        ...(state.dari ? { dari: state.dari } : {}),
        ...(state.sampai ? { sampai: state.sampai } : {}),
        ...(state.q.trim() ? { q: state.q.trim() } : {}),
        ...(state.sumber === 'supply' || state.sumber === 'warranty' ? { source: state.sumber } : {}),
        page,
        limit: pageSize,
      }),
    [state.lokasi, state.dari, state.sampai, state.q, state.sumber, outletId, page, pageSize],
  )
  useResetPageOnChange(outletId, page, () => setState({ hal: 1 }, { replace: true }))
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // A page past the end (rows swept or deleted meanwhile) comes back empty with the real total: land on the last page.
  useEffect(() => {
    if (q.loading || !q.data || q.data.meta?.page !== page) return
    const target = pastEndPage(page, totalPages, rows.length)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [q.loading, q.data, page, rows.length, totalPages, setState])

  const setFilter = (patch: Partial<GoodsReceiptListState>, replace = false) => setState({ ...patch, hal: 1 }, { replace })
  const reset = () => setState({ lokasi: '', dari: '', sampai: '', q: '', sumber: '', hal: 1 })
  const activeCount = [state.lokasi, state.dari, state.sampai, state.q, state.sumber].filter(Boolean).length

  const locationOptions = [
    { value: '', label: 'Semua lokasi' },
    ...(outletsQ.data ?? []).map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
    ...(warehousesQ.data ?? []).map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
  ]

  const columns: Column<GoodsReceiptListItem>[] = [
    { id: 'when', header: 'Waktu', cell: (g) => fmtDateTime(g.createdAt) },
    { id: 'location', header: 'Lokasi', cell: (g) => g.locationName ?? '—' },
    {
      id: 'source',
      header: 'Jenis',
      cell: (g) => <StatusBadge map={GOODS_RECEIPT_SOURCE} value={g.source} />,
    },
    { id: 'supplier', header: 'Pemasok', cell: (g) => g.supplier || '—' },
    { id: 'lines', header: 'Baris', align: 'right', cell: (g) => g.lineCount },
    { id: 'qty', header: 'Total unit', align: 'right', cell: (g) => g.totalQty.toLocaleString('id-ID') },
    { id: 'by', header: 'Dicatat oleh', cell: (g) => g.createdByName ?? '—' },
    { id: 'note', header: 'Catatan', cell: (g) => <span className="line-clamp-2">{g.note || '—'}</span>, defaultHidden: true },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Barang Masuk"
        count={`${total} penerimaan`}
        subtitle="Setiap barang yang masuk ke outlet dan gudang. Tambah barang masuk dari Kartu Stok."
      />

      <FilterBar onReset={reset} activeCount={activeCount}>
        <FilterBar.Search
          label="Cari pemasok, catatan, atau produk"
          placeholder="Pemasok, catatan, produk"
          value={state.q}
          onChange={(v) => setFilter({ q: v }, true)}
        />
        <FilterBar.Select label="Lokasi" value={state.lokasi} onChange={(v) => setFilter({ lokasi: v })} options={locationOptions} />
        <FilterBar.Select label="Jenis" value={state.sumber} onChange={(v) => setFilter({ sumber: v })} options={SOURCE_OPTIONS} />
        <FilterBar.DateRange from={state.dari} to={state.sampai} onChange={(r) => setFilter({ dari: r.from, sampai: r.to })} />
        {outletId && <FilterBar.Scope extra="semua gudang" />}
      </FilterBar>

      <DataTable
        caption="Daftar barang masuk"
        columns={columns}
        rows={rows}
        rowKey={(g) => g.id}
        loading={q.loading}
        error={q.error}
        onRetry={() => void q.refetch()}
        columnPrefsKey="mandalika.backoffice.cols.barangMasuk"
        empty={<EmptyState icon={<PackagePlus />} title="Belum ada barang masuk" />}
        footer={
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onChange={(p) => setState({ hal: p })}
            pageSize={pageSize}
            onPageSizeChange={(s) => setState({ per: s, hal: 1 })}
          />
        }
      />
    </div>
  )
}
