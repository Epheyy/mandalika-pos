import { useState } from 'react'
import type { ErpOutboxItem, ErpRelayReport } from '@mandalika/api'
import { Cable } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { Select } from '../../ui/Field'
import { Tabs } from '../../ui/Tabs'
import {
  KIND_LABEL, KIND_ORDER, STATUS_LABEL, STATUS_ORDER, emptyTitle, relayMessage,
  type ErpKind, type ErpStatus,
} from './erpOutboxFormat'
import { ErpOutboxTable } from './ErpOutboxTable'
import { ErpOutboxDetail } from './ErpOutboxDetail'

type StatusFilter = ErpStatus | 'all'

// TODO(step 4): the "last catalog run" widget and "Tarik katalog sekarang" button go in the PageHeader actions.

function useRelayRun(onDone: () => void) {
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const run = async () => {
    setRunning(true)
    setMessage(null)
    try {
      const r: ErpRelayReport = await api.runErpRelay()
      setMessage(relayMessage(r))
      onDone()
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : 'Gagal menjalankan relay')
    } finally {
      setRunning(false)
    }
  }
  return { running, message, run }
}

export default function ErpOutboxScreen() {
  const [status, setStatus] = useState<StatusFilter>('dead')
  const [kind, setKind] = useState<ErpKind | ''>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [selected, setSelected] = useState<ErpOutboxItem | null>(null)

  const q = usePolledQuery(
    () => api.listErpOutbox({
      page,
      limit: pageSize,
      ...(status !== 'all' ? { status } : {}),
      ...(kind ? { kind } : {}),
    }),
    [page, pageSize, status, kind],
  )
  const relay = useRelayRun(() => void q.refetch())
  const rows = q.data?.items ?? []
  const total = q.data?.meta?.total ?? 0
  const counts = q.data?.counts
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const tabs = [
    { id: 'all' as StatusFilter, label: 'Semua' },
    ...STATUS_ORDER.map((s) => ({
      id: s as StatusFilter,
      label: counts ? `${STATUS_LABEL[s]} ${counts[s]}` : STATUS_LABEL[s],
    })),
  ]

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Integrasi ERP"
        subtitle="Dokumen stok yang dikirim ke ERP"
        actions={
          <Button onClick={() => void relay.run()} loading={relay.running}>
            Kirim sekarang
          </Button>
        }
      />
      {relay.message && <p role="status" className="text-sm font-semibold text-gray-700">{relay.message}</p>}
      {q.error && <p role="alert" className="text-sm text-red-600">{q.error}</p>}

      <div className="flex flex-wrap items-end gap-3">
        <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1) }} tabs={tabs} className="flex-wrap" />
        <Select
          aria-label="Filter jenis"
          value={kind}
          onChange={(e) => { setKind(e.target.value as ErpKind | ''); setPage(1) }}
        >
          <option value="">Semua jenis</option>
          {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </Select>
      </div>

      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Cable />} title={emptyTitle(status === 'all' ? '' : status)} />
        ) : (
          <ErpOutboxTable rows={rows} onOpen={setSelected} />
        )}
      </Card>

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
      />
      {/* After a retry the row leaves the current filter; back to page 1 so the page can't fall past the end. */}
      <ErpOutboxDetail
        item={selected}
        onClose={() => setSelected(null)}
        onChanged={() => { if (page !== 1) setPage(1); else void q.refetch() }}
      />
    </div>
  )
}
