import { useEffect, useState } from 'react'
import type { Outlet, SyncReviewItem, SyncReviewItemList } from '@mandalika/api'
import { ClipboardCheck } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { Tabs } from '../../ui/Tabs'
import { useScreenTabs } from '../../lib/router/useScreenTabs'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { FilterBar } from '../../ui/FilterBar'
import { Pagination } from '../../ui/Pagination'
import { REASON_FILTERS, fmtWib, isStale, reasonFilterOf, reasonLabel, shouldStepBack, typeLabel } from './reviewLabels'
import { SyncReviewDetail } from './SyncReviewDetail'

type Status = 'open' | 'resolved'

interface ReviewListState {
  outlet: string
  alasan: string
  hal: number
  per: number
  [key: string]: string | number
}

// Terbuka / Selesai live in the path, and a tab switch drops the query, so these filters belong to one tab.
const LIST_SCHEMA: ListSchema<ReviewListState> = {
  outlet: { key: 'outlet', default: '' },
  alasan: { key: 'alasan', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

const PAGE_SIZES = [25, 50, 100]

export default function SyncReview() {
  // Terbuka / Selesai live in the path (#/tinjauan-sinkron/selesai); a bare #/tinjauan-sinkron is Terbuka.
  const { tab: routedStatus, setTab: setStatus } = useScreenTabs<Status>('syncReview', null)
  const status: Status = routedStatus ?? 'open'
  const [state, setState] = useListState(LIST_SCHEMA)
  const outletId = state.outlet
  const reviewCode = reasonFilterOf(state.alasan)
  const pageSize = PAGE_SIZES.includes(state.per) ? state.per : LIST_SCHEMA.per.default
  const page = Math.max(1, Math.floor(state.hal))
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

  // Back/Forward between Terbuka and Selesai must not carry an open detail over to the other list.
  useEffect(() => {
    setSelected(null)
  }, [status])

  // Resolving the last row on a later page (here or by another user) leaves it empty.
  useEffect(() => {
    if (shouldStepBack({ loading: q.loading, error: q.error, rowCount: rows.length, page })) setState({ hal: page - 1 }, { replace: true })
  }, [q.loading, q.error, rows.length, page, setState])

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Tinjauan Sinkron"
        subtitle="Item sinkron yang ditolak server dari semua tablet. Perbaiki secara manual bila perlu, lalu tandai selesai." />
      <FilterBar
        onReset={() => setState({ outlet: '', alasan: '', hal: 1 })}
        activeCount={(outletId ? 1 : 0) + (reviewCode ? 1 : 0)}
      >
        <Tabs<Status> value={status} onChange={(v) => setStatus(v)}
          tabs={[{ id: 'open', label: `Terbuka (${openCount})` }, { id: 'resolved', label: 'Selesai' }]} />
        <FilterBar.Select label="Outlet" value={outletId} onChange={(v) => setState({ outlet: v, hal: 1 })}
          options={[{ value: '', label: 'Semua outlet' }, ...(outletsQ.data ?? []).map((o) => ({ value: o.id, label: o.name }))]} />
        <FilterBar.Select label="Alasan" value={reviewCode} onChange={(v) => setState({ alasan: v, hal: 1 })}
          options={REASON_FILTERS.map((r) => ({ value: r.id, label: r.label }))} />
      </FilterBar>
      {q.error && <p role="alert" className="text-sm text-red-600">{q.error}</p>}
      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          q.error ? null : <EmptyState icon={<ClipboardCheck />} title={status === 'open' ? 'Tidak ada item terbuka' : 'Belum ada item selesai'} />
        ) : (
          <ul className="divide-y divide-gray-50">
            {rows.map((it) => <ReviewListRow key={it.idempotencyKey} item={it} onOpen={() => setSelected(it)} />)}
          </ul>
        )}
      </Card>
      <Pagination page={page} totalPages={totalPages} total={total} onChange={(p) => setState({ hal: p })}
        pageSize={pageSize} onPageSizeChange={(s) => setState({ per: s, hal: 1 })} />
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
