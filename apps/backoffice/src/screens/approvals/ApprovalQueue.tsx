import { useEffect, useState } from 'react'
import type { ApprovalQueueItem, ApprovalQueueResponse } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { ClipboardCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { signed } from '../../lib/inventoryApproval'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { useOutlet } from '../../outlet'
import { Badge } from '../../ui/Badge'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { FilterBar } from '../../ui/FilterBar'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { ApprovalDetail } from './ApprovalDetail'
import { approvalFilterOf, kindOf, outletOf } from './approvalFilters'
import { notifyApprovalsChanged } from './useApprovalCount'

interface ApprovalListState {
  outlet: string
  jenis: string
  hal: number
  per: number
  [key: string]: string | number
}

const LIST_SCHEMA: ListSchema<ApprovalListState> = {
  outlet: { key: 'outlet', default: '' },
  jenis: { key: 'jenis', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

const PAGE_SIZES = [25, 50, 100]

const KIND_OPTIONS = [
  { value: '', label: 'Semua jenis' },
  { value: 'adjustment', label: 'Penyesuaian' },
  { value: 'count', label: 'Opname' },
]

const typeLabel = (t: ApprovalQueueItem['type']) => (t === 'adjustment' ? 'Penyesuaian' : 'Opname')
const locLabel = (t: string) => (t === 'warehouse' ? 'Gudang' : 'Outlet')

/** Persetujuan Stok: pending adjustment requests and submitted stock counts, oldest first. */
export default function ApprovalQueue() {
  const { outletId: headerOutletId, outlets } = useOutlet()
  const [state, setState] = useListState(LIST_SCHEMA)
  const [selected, setSelected] = useState<ApprovalQueueItem | null>(null)
  const pageSize = PAGE_SIZES.includes(state.per) ? state.per : LIST_SCHEMA.per.default
  const page = Math.max(1, Math.floor(state.hal))
  const outlet = outletOf(state.outlet)
  const kind = kindOf(state.jenis)
  const filter = approvalFilterOf(state)

  // The sidebar badge (useApprovalCount) asks without filters, so choosing a filter here never changes it.
  const q = usePolledQuery<ApprovalQueueResponse>(
    () => api.listInventoryApprovals(page, pageSize, filter),
    [page, pageSize, outlet, kind, headerOutletId],
  )
  const items = q.data?.data ?? []
  const total = q.data?.meta?.total ?? items.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // Approving or rejecting the last row of a later page leaves it empty: step back.
  useEffect(() => {
    if (!q.loading && !q.error && q.data?.meta?.page === page && items.length === 0 && page > 1) setState({ hal: page - 1 }, { replace: true })
  }, [q.loading, q.error, q.data, items.length, page, setState])

  const onDone = async () => {
    setSelected(null)
    await q.refetch()
    notifyApprovalsChanged()
  }

  const scopeName = headerOutletId ? outlets.find((o) => o.id === headerOutletId)?.name : undefined
  const outletOptions = [
    { value: '', label: scopeName ? `${scopeName} (sesuai header)` : 'Semua outlet' },
    ...outlets.map((o) => ({ value: o.id, label: o.name })),
  ]
  const activeCount = (outlet ? 1 : 0) + (kind ? 1 : 0)

  const columns: Column<ApprovalQueueItem>[] = [
    { id: 'number', header: 'Nomor / Nama', cell: (it) => <span className="font-bold">{it.number ?? '-'}</span> },
    { id: 'type', header: 'Jenis', cell: (it) => <Badge tone={it.type === 'adjustment' ? 'gold' : 'neutral'}>{typeLabel(it.type)}</Badge> },
    { id: 'location', header: 'Lokasi', cell: (it) => `${locLabel(it.locationType)} ${it.locationName ?? ''}` },
    { id: 'requester', header: 'Pengaju', cell: (it) => it.requestedByName ?? '-' },
    { id: 'at', header: 'Waktu', cell: (it) => format(parseISO(it.at), 'dd MMM yyyy HH:mm', { locale: idLocale }) },
    { id: 'lines', header: 'Baris', align: 'right', cell: (it) => it.lines },
    {
      id: 'net',
      header: 'Selisih Bersih',
      align: 'right',
      cell: (it) => (
        <span className={`font-black ${it.netDelta > 0 ? 'text-green-600' : it.netDelta < 0 ? 'text-red-600' : 'text-gray-400'}`}>{signed(it.netDelta)}</span>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Persetujuan Stok"
        count={`${total} menunggu`}
        subtitle="Penyetuju tidak bisa menyetujui pengajuannya sendiri."
      />
      <FilterBar onReset={() => setState({ outlet: '', jenis: '', hal: 1 })} activeCount={activeCount}>
        <FilterBar.Select label="Outlet" value={outlet} onChange={(v) => setState({ outlet: v, hal: 1 })} options={outletOptions} />
        <FilterBar.Select label="Jenis" value={kind} onChange={(v) => setState({ jenis: v, hal: 1 })} options={KIND_OPTIONS} />
      </FilterBar>
      {outlet && <p className="text-xs text-ink-700">Dokumen gudang tidak tampil saat satu outlet dipilih.</p>}

      <DataTable
        caption="Antrean persetujuan stok"
        columns={columns}
        rows={items}
        rowKey={(it) => `${it.type}-${it.id}`}
        loading={q.loading && items.length === 0}
        error={q.error ? 'Antrean persetujuan gagal dimuat.' : null}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<ClipboardCheck />} title="Tidak ada yang menunggu persetujuan" />}
        onRowClick={setSelected}
        selectedKey={selected ? `${selected.type}-${selected.id}` : null}
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
      {selected && <ApprovalDetail item={selected} onClose={() => setSelected(null)} onDone={onDone} />}
    </div>
  )
}
