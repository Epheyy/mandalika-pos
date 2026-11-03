import { fetchAllPages, type Outlet, type Transfer, type Warehouse } from '@mandalika/api'
import { PackageCheck, Plus } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { exportToCSV, exportToXLSX, buildExportName } from '../../lib/csvUtils'
import { labelOf } from '../../lib/labels/types'
import { TRANSFER_STATUS } from '../../lib/labels/transfer'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { useOutlet } from '../../outlet'
import { Button } from '../../ui/Button'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ExportButton } from '../../ui/ExportButton'
import { FilterBar } from '../../ui/FilterBar'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { StatusBadge } from '../../ui/StatusBadge'
import { effectiveLocation } from './transferAction'

interface TransferListState {
  status: string
  lokasi: string
  dari: string
  sampai: string
  hal: number
  per: number
  [key: string]: string | number
}

const LIST_SCHEMA: ListSchema<TransferListState> = {
  status: { key: 'status', default: '' },
  lokasi: { key: 'lokasi', default: '' },
  dari: { key: 'dari', default: '' },
  sampai: { key: 'sampai', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

const PAGE_SIZES = [25, 50, 100]

// ISO date string "YYYY-MM-DD" → "YYYY-MM-DDT00:00:00Z"
const toFromIso = (date: string): string => `${date}T00:00:00Z`

// ISO date string "YYYY-MM-DD" → next day at midnight UTC (exclusive end)
function toToIso(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

const STATUS_OPTIONS = [
  { value: '', label: 'Semua status' },
  ...Object.entries(TRANSFER_STATUS).map(([value, v]) => ({ value, label: v.label })),
]

interface TransferListProps {
  outlets: Outlet[]
  warehouses: Warehouse[]
  onCreate: () => void
  onOpen: (id: string) => void
}

export function TransferList({ outlets, warehouses, onCreate, onOpen }: TransferListProps) {
  const { outletId } = useOutlet()
  const [state, setState] = useListState(LIST_SCHEMA)
  const pageSize = PAGE_SIZES.includes(state.per) ? state.per : LIST_SCHEMA.per.default
  const page = Math.max(1, Math.floor(state.hal))
  const loc = effectiveLocation(state.lokasi, outletId)

  const filters = {
    ...(state.status ? { status: state.status } : {}),
    ...(state.dari ? { from: toFromIso(state.dari) } : {}),
    ...(state.sampai ? { to: toToIso(state.sampai) } : {}),
    ...(loc ? { locKind: loc.kind, locId: loc.id } : {}),
  }

  const q = usePolledQuery(
    () => api.listTransfers({ ...filters, page, limit: pageSize }),
    [state.status, state.lokasi, state.dari, state.sampai, outletId, page, pageSize],
  )
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // Any filter change returns to page 1.
  const setFilter = (patch: Partial<TransferListState>) => setState({ ...patch, hal: 1 })
  const reset = () => setState({ status: '', lokasi: '', dari: '', sampai: '', hal: 1 })
  const activeCount = [state.status, state.lokasi, state.dari, state.sampai].filter(Boolean).length

  const locName = loc ? (loc.kind === 'outlet' ? outlets : warehouses).find((l) => l.id === loc.id)?.name : undefined
  const scopeName = outletId ? outlets.find((o) => o.id === outletId)?.name : undefined
  const locationOptions = [
    { value: '', label: scopeName ? `${scopeName} (sesuai header)` : 'Semua lokasi' },
    ...outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
    ...warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
  ]

  const exportTransfers = async (fmt: 'csv' | 'xlsx') => {
    const all = await fetchAllPages((p, limit) => api.listTransfers({ ...filters, page: p, limit }))
    const exportRows = all.map((t) => ({
      No: t.transferNo,
      Sumber: t.source.name,
      Tujuan: t.dest.name,
      Status: labelOf(TRANSFER_STATUS, t.status).label,
      Dibuat: fmtDate(t.createdAt),
    }))
    const name = buildExportName('transfer-produk', [
      state.status ? labelOf(TRANSFER_STATUS, state.status).label : undefined,
      locName,
      state.dari ? `dari-${state.dari}` : undefined,
      state.sampai ? `sd-${state.sampai}` : undefined,
    ])
    if (fmt === 'csv') exportToCSV(exportRows, name)
    else exportToXLSX(exportRows, name)
  }

  const columns: Column<Transfer>[] = [
    { id: 'no', header: 'No', cell: (t) => <span className="font-mono">{t.transferNo}</span> },
    { id: 'source', header: 'Sumber', cell: (t) => t.source.name },
    { id: 'dest', header: 'Tujuan', cell: (t) => t.dest.name },
    { id: 'status', header: 'Status', cell: (t) => <StatusBadge map={TRANSFER_STATUS} value={t.status} /> },
    { id: 'created', header: 'Dibuat', cell: (t) => fmtDate(t.createdAt) },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Transfer Stok"
        count={`${total} transfer`}
        actions={
          <>
            <ExportButton
              formats={['csv', 'xlsx']}
              rowCount={q.data ? total : null}
              filterSummary={[
                ...(state.status ? [`Status: ${labelOf(TRANSFER_STATUS, state.status).label}`] : []),
                ...(locName ? [`Lokasi: ${locName}`] : []),
                ...(state.dari ? [`Dari: ${state.dari}`] : []),
                ...(state.sampai ? [`Sampai: ${state.sampai}`] : []),
              ]}
              onExport={exportTransfers}
              disabled={total === 0}
            />
            <Button onClick={onCreate} icon={<Plus className="w-4 h-4" />}>
              Transfer Baru
            </Button>
          </>
        }
      />

      <FilterBar onReset={reset} activeCount={activeCount}>
        <FilterBar.Select label="Status" value={state.status} onChange={(v) => setFilter({ status: v })} options={STATUS_OPTIONS} />
        <FilterBar.Select label="Lokasi" value={state.lokasi} onChange={(v) => setFilter({ lokasi: v })} options={locationOptions} />
        <FilterBar.DateRange from={state.dari} to={state.sampai} onChange={(r) => setFilter({ dari: r.from, sampai: r.to })} />
        {!state.lokasi && outletId && <FilterBar.Scope extra="transfer masuk dan keluar" />}
      </FilterBar>

      <DataTable
        caption="Daftar transfer stok"
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        loading={q.loading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<PackageCheck />} title="Belum ada transfer" />}
        onRowClick={(t) => onOpen(t.id)}
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
