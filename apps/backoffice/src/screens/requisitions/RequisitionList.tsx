import { useEffect, useRef } from 'react'
import type { StockRequisition } from '@mandalika/api'
import { ArrowLeft, ClipboardList, Plus } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { useOutlet } from '../../outlet'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { FilterBar } from '../../ui/FilterBar'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { backOrNavigate, navigate } from '../../lib/router/navigate'
import { useListState } from '../../lib/router/useListState'
import { useRoute } from '../../lib/router/useRoute'
import { RequisitionDetail } from './RequisitionDetail'
import { RequisitionForm } from './RequisitionForm'
import { REQUISITION_STATUS, fmtDate } from './requisitionStatus'
import {
  REQUISITION_LIST_SCHEMA,
  REQUISITION_PAGE_SIZES,
  isRequisitionListPath,
  requisitionHash,
  requisitionPageOf,
  requisitionSizeOf,
  requisitionStatusOf,
  requisitionViewFromPath,
} from './requisitionRoute'

/** Permintaan Barang screen. Outlet staff see their own outlet's requests; the warehouse sees every submitted one. */
export default function Requisitions() {
  // The view lives in the path: #/permintaan-barang, /baru, /<id>, /<id>/ubah.
  const view = requisitionViewFromPath(useRoute().path)
  const go = (to: Parameters<typeof requisitionHash>[0], replace = false) => void navigate(requisitionHash(to), { replace })
  // "Kembali" steps back to the list as it was (filters and page are in its URL); a pasted link has no such entry.
  const toList = () => void backOrNavigate(requisitionHash({ kind: 'list' }), isRequisitionListPath)
  // A saved new request replaces its own entry, so Back does not return to a form that is already submitted.
  const saved = (id: string) => go({ kind: 'detail', id }, true)
  // Leaving the edit form (saved, cancelled, or not editable after all) steps back to the detail it was opened from,
  // so the history keeps one entry for it; a pasted link to the form has no such entry and replaces itself with it.
  const leaveEdit = (id: string) => {
    const isDetail = (path: readonly string[]) => {
      const v = requisitionViewFromPath(path)
      return v.kind === 'detail' && v.id === id
    }
    void backOrNavigate(requisitionHash({ kind: 'detail', id }), isDetail, { replace: true })
  }
  if (view.kind === 'create') {
    return <div className="p-6"><RequisitionForm onCancel={toList} onSaved={saved} /></div>
  }
  if (view.kind === 'edit') {
    return <div className="p-6"><RequisitionEdit id={view.id} onBack={() => leaveEdit(view.id)} onSaved={leaveEdit} /></div>
  }
  if (view.kind === 'detail') {
    return <div className="p-6"><RequisitionDetail id={view.id} onBack={toList} onEdit={(pb) => go({ kind: 'edit', id: pb.id })} /></div>
  }
  return <RequisitionList onCreate={() => go({ kind: 'create' })} onOpen={(id) => go({ kind: 'detail', id })} />
}

interface RequisitionEditProps {
  id: string
  onBack: () => void
  onSaved: (id: string) => void
}

/** The edit form for a draft, loaded by id so a reload or a pasted link lands on it. */
function RequisitionEdit({ id, onBack, onSaved }: RequisitionEditProps) {
  // Loaded once: the form seeds its fields from the draft, and a poll must not re-seed what the user is typing.
  const q = usePolledQuery<StockRequisition>(() => api.getRequisition(id), [id], 24 * 3600 * 1000)
  const { user } = useAuth()
  const { outletId } = useOutlet()
  const pb = q.data
  // Only the requesting outlet edits a draft (the Ubah button's own gate). A pasted link to anything else shows the detail.
  const activeOutlet = user?.role === 'admin' ? outletId : (user?.outletId ?? null)
  const mayEdit = !!pb && pb.status === 'draft' && activeOutlet === pb.outletId
  const bounced = useRef(false)
  useEffect(() => {
    if (!pb || mayEdit || bounced.current) return
    bounced.current = true
    onBack()
  }, [pb, mayEdit, onBack])
  if (!pb || !mayEdit) {
    return (
      <div className="space-y-5">
        <PageHeader title="Permintaan Barang" actions={<Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>Kembali</Button>} />
        <Card className="p-8">{q.error ? <p className="text-sm text-danger">{q.error}</p> : <TableSkeleton />}</Card>
      </div>
    )
  }
  return <RequisitionForm draft={pb} onCancel={onBack} onSaved={onSaved} />
}

interface RequisitionListProps {
  onCreate: () => void
  onOpen: (id: string) => void
}

const LIST_COLUMNS: Column<StockRequisition>[] = [
  { id: 'number', header: 'No', cell: (r) => <span className="font-mono text-sm text-ink-900">{r.number}</span> },
  { id: 'outlet', header: 'Outlet', cell: (r) => <span className="text-sm text-ink-700">{r.outletName}</span> },
  { id: 'warehouse', header: 'Gudang', cell: (r) => <span className="text-sm text-ink-700">{r.warehouseName ?? '—'}</span> },
  {
    id: 'status',
    header: 'Status',
    cell: (r) => {
      const s = REQUISITION_STATUS[r.status]
      return <Badge tone={s.tone}>{s.label}</Badge>
    },
  },
  { id: 'needed', header: 'Dibutuhkan', cell: (r) => <span className="text-sm text-ink-700">{fmtDate(r.neededBy)}</span> },
  { id: 'transfer', header: 'Transfer', cell: (r) => <span className="font-mono text-sm text-ink-700">{r.transfer?.transferNo ?? '—'}</span> },
]

function RequisitionList({ onCreate, onOpen }: RequisitionListProps) {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  const isAdmin = user?.role === 'admin'
  const canRequest = isAdmin || (user?.permissions ?? []).includes('request_stock')
  // An admin raises a PB for one outlet at a time (X-Outlet-Id); without one the server answers 400.
  const needsOutlet = isAdmin && !outletId
  // Status, page and page size are URL state (#/permintaan-barang?status=&hal=&per=).
  const [state, setState] = useListState(REQUISITION_LIST_SCHEMA)
  const status = requisitionStatusOf(state.status)
  const page = requisitionPageOf(state.hal)
  const pageSize = requisitionSizeOf(state.per)

  const q = usePolledQuery(
    () => api.listRequisitions({ ...(status ? { status } : {}), page, limit: pageSize }),
    [status, page, pageSize],
  )
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Permintaan Barang"
        subtitle={`${total} permintaan`}
        actions={canRequest ? (
          <Button onClick={onCreate} disabled={needsOutlet} title={needsOutlet ? 'Pilih outlet dulu' : undefined} icon={<Plus className="w-4 h-4" />}>
            Permintaan Baru
          </Button>
        ) : undefined}
      />
      {canRequest && needsOutlet && <p className="text-sm text-ink-700">Pilih outlet dulu (menu di kanan atas) untuk membuat permintaan baru.</p>}
      <FilterBar onReset={() => setState({ status: '', hal: 1 })} activeCount={status ? 1 : 0}>
        <FilterBar.Scope />
        <FilterBar.Select
          label="Status"
          value={status}
          onChange={(next) => setState({ status: next, hal: 1 })}
          options={[{ value: '', label: 'Semua status' }, ...Object.entries(REQUISITION_STATUS).map(([k, v]) => ({ value: k, label: v.label }))]}
        />
      </FilterBar>
      <DataTable
        caption="Daftar permintaan barang"
        columns={LIST_COLUMNS}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.loading}
        error={q.error ? `Daftar permintaan gagal dimuat: ${q.error}` : null}
        onRetry={() => void q.refetch()}
        onRowClick={(r) => onOpen(r.id)}
        empty={<EmptyState icon={<ClipboardList />} title={status ? 'Tidak ada permintaan dengan status ini' : 'Belum ada permintaan barang'} />}
        footer={
          <Pagination
            page={page} totalPages={Math.max(1, Math.ceil(total / pageSize))} total={total} onChange={(hal) => setState({ hal })}
            pageSize={pageSize} onPageSizeChange={(per) => setState({ per, hal: 1 })} pageSizes={[...REQUISITION_PAGE_SIZES]}
          />
        }
      />
    </div>
  )
}
