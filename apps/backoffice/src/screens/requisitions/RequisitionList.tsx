import { useEffect, useRef, useState } from 'react'
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
import { EmptyState } from '../../ui/EmptyState'
import { Select } from '../../ui/Field'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { backOrNavigate, navigate } from '../../lib/router/navigate'
import { useRoute } from '../../lib/router/useRoute'
import { RequisitionDetail } from './RequisitionDetail'
import { RequisitionForm } from './RequisitionForm'
import { REQUISITION_STATUS, fmtDate } from './requisitionStatus'
import { requisitionHash, requisitionViewFromPath } from './requisitionRoute'

/** Permintaan Barang screen. Outlet staff see their own outlet's requests; the warehouse sees every submitted one. */
export default function Requisitions() {
  // The view lives in the path: #/permintaan-barang, /baru, /<id>, /<id>/ubah.
  const view = requisitionViewFromPath(useRoute().path)
  const go = (to: Parameters<typeof requisitionHash>[0], replace = false) => void navigate(requisitionHash(to), { replace })
  const toList = () => go({ kind: 'list' })
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
        <Card className="p-8">{q.error ? <p className="text-sm text-red-600">{q.error}</p> : <TableSkeleton />}</Card>
      </div>
    )
  }
  return <RequisitionForm draft={pb} onCancel={onBack} onSaved={onSaved} />
}

interface RequisitionListProps {
  onCreate: () => void
  onOpen: (id: string) => void
}

function RequisitionList({ onCreate, onOpen }: RequisitionListProps) {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  const isAdmin = user?.role === 'admin'
  const canRequest = isAdmin || (user?.permissions ?? []).includes('request_stock')
  // An admin raises a PB for one outlet at a time (X-Outlet-Id); without one the server answers 400.
  const needsOutlet = isAdmin && !outletId
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const q = usePolledQuery(
    () => api.listRequisitions({ ...(status ? { status: status as StockRequisition['status'] } : {}), page, limit: pageSize }),
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
      {canRequest && needsOutlet && <p className="text-sm text-gray-500">Pilih outlet dulu (menu di kanan atas) untuk membuat permintaan baru.</p>}
      <div className="min-w-[180px] max-w-xs">
        <Select label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">Semua status</option>
          {Object.entries(REQUISITION_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </div>
      <Card className="overflow-hidden">
        {q.loading ? (
          <TableSkeleton />
        ) : q.error ? (
          <p className="p-5 text-sm text-red-600">{q.error}</p>
        ) : rows.length === 0 ? (
          <EmptyState icon={<ClipboardList />} title="Belum ada permintaan barang" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['No', 'Outlet', 'Gudang', 'Status', 'Dibutuhkan', 'Transfer'].map((h) => (
                    <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const s = REQUISITION_STATUS[r.status]
                  return (
                    <tr key={r.id} onClick={() => onOpen(r.id)} className="hover:bg-gray-50 cursor-pointer">
                      <td className="px-5 py-3 font-mono text-sm text-gray-900">{r.number}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">{r.outletName}</td>
                      <td className="px-5 py-3 text-sm text-gray-500">{r.warehouseName ?? '—'}</td>
                      <td className="px-5 py-3"><Badge tone={s.tone}>{s.label}</Badge></td>
                      <td className="px-5 py-3 text-sm text-gray-500">{fmtDate(r.neededBy)}</td>
                      <td className="px-5 py-3 font-mono text-sm text-gray-500">{r.transfer?.transferNo ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Pagination
        page={page} totalPages={Math.max(1, Math.ceil(total / pageSize))} total={total} onChange={setPage}
        pageSize={pageSize} onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
      />
    </div>
  )
}
