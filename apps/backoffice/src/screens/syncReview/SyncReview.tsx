import { useState } from 'react'
import type { Outlet, SyncReviewItem, SyncReviewItemList } from '@mandalika/api'
import { ClipboardCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { Tabs } from '../../ui/Tabs'
import { Pagination } from '../../ui/Pagination'
import { Select } from '../../ui/Field'
import { REASON_FILTERS, fmtWib, isStale, reasonLabel, typeLabel } from './reviewLabels'
import { SyncReviewDetail } from './SyncReviewDetail'

type Status = 'open' | 'resolved'

export default function SyncReview() {
  const [status, setStatus] = useState<Status>('open')
  const [outletId, setOutletId] = useState('')
  const [reviewCode, setReviewCode] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<SyncReviewItem | null>(null)

  const q = usePolledQuery<SyncReviewItemList>(
    () => api.listSyncReviewItems({ status, page, limit: pageSize, outletId, reviewCode }),
    [status, page, pageSize, outletId, reviewCode],
    60_000,
  )
  const outletsQ = usePolledQuery<Outlet[]>(() => api.listOutlets(), [], 300_000)
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const openCount = q.data?.openCount ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Tinjauan Sinkron"
        subtitle="Item sinkron yang ditolak server dari semua tablet. Perbaiki secara manual bila perlu, lalu tandai selesai." />
      <div className="flex flex-wrap items-end gap-3">
        <Tabs<Status> value={status} onChange={(v) => { setStatus(v); setPage(1) }}
          tabs={[{ id: 'open', label: `Terbuka (${openCount})` }, { id: 'resolved', label: 'Selesai' }]} />
        <Select aria-label="Filter outlet" value={outletId} onChange={(e) => { setOutletId(e.target.value); setPage(1) }}>
          <option value="">Semua outlet</option>
          {(outletsQ.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
        <Select aria-label="Filter alasan" value={reviewCode} onChange={(e) => { setReviewCode(e.target.value); setPage(1) }}>
          {REASON_FILTERS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </Select>
      </div>
      {q.error && <p role="alert" className="text-sm text-red-600">{q.error}</p>}
      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ClipboardCheck />} title={status === 'open' ? 'Tidak ada item terbuka' : 'Belum ada item selesai'} />
        ) : (
          <ul className="divide-y divide-gray-50">
            {rows.map((it) => <ReviewListRow key={it.idempotencyKey} item={it} onOpen={() => setSelected(it)} />)}
          </ul>
        )}
      </Card>
      <Pagination page={page} totalPages={totalPages} total={total} onChange={setPage}
        pageSize={pageSize} onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} />
      <SyncReviewDetail item={selected} onClose={() => setSelected(null)}
        onResolved={() => { setSelected(null); void q.refetch() }} />
    </div>
  )
}

function ReviewListRow({ item, onOpen }: { item: SyncReviewItem; onOpen: () => void }) {
  const movedFrom = item.capturedOutletName && item.capturedOutletId !== item.outletId ? item.capturedOutletName : null
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full text-left px-5 py-4 hover:bg-gray-50 focus-visible:bg-gray-50">
        <p className="font-bold text-gray-900 text-sm">
          {typeLabel(item.type)} · <span className="text-red-700">{reasonLabel(item.reviewCode)}</span>
        </p>
        <p className="text-xs text-gray-500">
          {item.outletName}{movedFrom ? ` (dibuat di ${movedFrom})` : ''}
          {item.ownerName ? ` · ${item.ownerName}` : ''}
          {' · '}{fmtWib(item.clientCreatedAt)} (menurut tablet)
        </p>
        {item.resolvedAt ? (
          <p className="text-xs text-green-700">Selesai oleh {item.resolvedByName ?? '—'} · {fmtWib(item.resolvedAt)} · {item.resolutionNote}</p>
        ) : isStale(item.lastReportedAt) ? (
          <p className="text-xs text-amber-700">tablet belum terhubung sejak {fmtWib(item.lastReportedAt)}</p>
        ) : null}
      </button>
    </li>
  )
}
