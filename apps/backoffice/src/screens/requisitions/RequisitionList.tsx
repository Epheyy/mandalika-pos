import { useState } from 'react'
import type { StockRequisition } from '@mandalika/api'
import { ClipboardList, Plus } from 'lucide-react'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Select } from '../../ui/Field'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { RequisitionDetail } from './RequisitionDetail'
import { RequisitionForm } from './RequisitionForm'
import { REQUISITION_STATUS, fmtDate } from './requisitionStatus'

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; pb: StockRequisition }
  | { kind: 'detail'; id: string }

/** Permintaan Barang screen. Outlet staff see their own outlet's requests; the warehouse sees every submitted one. */
export default function Requisitions() {
  const [view, setView] = useState<View>({ kind: 'list' })
  if (view.kind === 'create') {
    return <div className="p-6"><RequisitionForm onCancel={() => setView({ kind: 'list' })} onSaved={(id) => setView({ kind: 'detail', id })} /></div>
  }
  if (view.kind === 'edit') {
    const id = view.pb.id
    return <div className="p-6"><RequisitionForm draft={view.pb} onCancel={() => setView({ kind: 'detail', id })} onSaved={(sid) => setView({ kind: 'detail', id: sid })} /></div>
  }
  if (view.kind === 'detail') {
    return <div className="p-6"><RequisitionDetail id={view.id} onBack={() => setView({ kind: 'list' })} onEdit={(pb) => setView({ kind: 'edit', pb })} /></div>
  }
  return <RequisitionList onCreate={() => setView({ kind: 'create' })} onOpen={(id) => setView({ kind: 'detail', id })} />
}

interface RequisitionListProps {
  onCreate: () => void
  onOpen: (id: string) => void
}

function RequisitionList({ onCreate, onOpen }: RequisitionListProps) {
  const { user } = useAuth()
  const canRequest = user?.role === 'admin' || (user?.permissions ?? []).includes('request_stock')
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
        actions={canRequest ? <Button onClick={onCreate} icon={<Plus className="w-4 h-4" />}>Permintaan Baru</Button> : undefined}
      />
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
