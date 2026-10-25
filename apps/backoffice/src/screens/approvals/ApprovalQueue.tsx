import { useState } from 'react'
import type { ApprovalQueueItem, ApprovalQueueResponse } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { ClipboardCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { signed } from '../../lib/inventoryApproval'
import { TableSkeleton } from '../../components/Skeleton'
import { Badge } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { ApprovalDetail } from './ApprovalDetail'
import { notifyApprovalsChanged } from './useApprovalCount'

const typeLabel = (t: ApprovalQueueItem['type']) => (t === 'adjustment' ? 'Penyesuaian' : 'Opname')
const locLabel = (t: string) => (t === 'warehouse' ? 'Gudang' : 'Outlet')

/** Persetujuan Stok: pending adjustment requests and submitted stock counts, oldest first. */
export default function ApprovalQueue() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<ApprovalQueueItem | null>(null)
  const q = usePolledQuery<ApprovalQueueResponse>(() => api.listInventoryApprovals(page, pageSize), [page, pageSize])
  const items = q.data?.data ?? []
  const total = q.data?.meta?.total ?? items.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const onDone = async () => {
    setSelected(null)
    await q.refetch()
    notifyApprovalsChanged()
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Persetujuan Stok"
        subtitle={`${q.data?.pendingCount ?? 0} menunggu persetujuan. Penyetuju tidak bisa menyetujui pengajuannya sendiri.`}
      />
      {q.error && <p role="alert" className="text-sm text-red-600">{q.error}</p>}
      {q.loading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <Card><EmptyState icon={<ClipboardCheck />} title="Tidak ada yang menunggu persetujuan" /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                {['Jenis', 'Nomor / Nama', 'Lokasi', 'Pengaju', 'Waktu', 'Baris', 'Selisih Bersih'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-xs font-black text-gray-400 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map((it) => (
                <tr key={`${it.type}-${it.id}`} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(it)}>
                  <td className="px-4 py-2"><Badge tone={it.type === 'adjustment' ? 'gold' : 'neutral'}>{typeLabel(it.type)}</Badge></td>
                  <td className="px-4 py-2 text-sm font-bold text-gray-900">
                    <button type="button" className="text-left" onClick={() => setSelected(it)}>{it.number ?? '-'}</button>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{locLabel(it.locationType)} {it.locationName ?? ''}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{it.requestedByName ?? '-'}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{format(parseISO(it.at), 'dd MMM yyyy HH:mm', { locale: idLocale })}</td>
                  <td className="px-4 py-2 text-sm text-gray-700">{it.lines}</td>
                  <td className={`px-4 py-2 text-sm font-black ${it.netDelta > 0 ? 'text-green-600' : it.netDelta < 0 ? 'text-red-600' : 'text-gray-400'}`}>{signed(it.netDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
      />
      {selected && <ApprovalDetail item={selected} onClose={() => setSelected(null)} onDone={onDone} />}
    </div>
  )
}
