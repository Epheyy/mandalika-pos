import { useState } from 'react'
import type { CrossOutletLookupLog, ListResult } from '@mandalika/api'
import { SearchCheck } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { usePastEndRedirect } from '../lib/pastEndRedirect'
import { Button } from '../ui/Button'
import { DataTable, type Column } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Pagination } from '../ui/Pagination'

const DEFAULT_PAGE_SIZE = 25
const KIND_LABEL: Record<string, string> = { order_number: 'No. order', phone: 'No. HP' }

const WIB = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

/** The log time in WIB, whatever the browser's own zone is. */
export function fmtLookupTime(s: string): string {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : `${WIB.format(d)} WIB`
}

/** "Log Pencarian Outlet Lain": head office sees every cross-outlet lookup, rate-limited ones marked (A18). Admin only. */
export default function CrossOutletLookups() {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const q = usePolledQuery<ListResult<CrossOutletLookupLog>>(
    () => api.listCrossOutletLookups({ page, limit: pageSize }),
    [page, pageSize],
  )
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  usePastEndRedirect(q, page, rows.length, totalPages, setPage)

  const columns: Column<CrossOutletLookupLog>[] = [
    { id: 'time', header: 'Waktu', cell: (r) => <span className="whitespace-nowrap">{fmtLookupTime(r.createdAt)}</span> },
    { id: 'user', header: 'Pengguna', cell: (r) => r.userName || r.userId },
    { id: 'outlet', header: 'Outlet', cell: (r) => r.outletName || r.outletId },
    { id: 'kind', header: 'Jenis', cell: (r) => KIND_LABEL[r.queryKind] ?? r.queryKind },
    { id: 'query', header: 'Pencarian', cell: (r) => <span className="font-mono">{r.queryValue}</span> },
    { id: 'count', header: 'Hasil', cell: (r) => r.resultCount },
    {
      id: 'limited', header: 'Status',
      cell: (r) => (r.rateLimited
        ? <span className="px-2 py-0.5 rounded-full bg-danger/10 text-danger text-xs font-bold">Dibatasi</span>
        : null),
    },
  ]

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Log Pencarian Outlet Lain"
        count={`${total} pencarian`}
        subtitle="Setiap pencarian transaksi outlet lain untuk refund, termasuk yang dibatasi. Nomor HP hanya tampil 4 digit terakhir."
        actions={<Button variant="secondary" onClick={() => void q.refetch()}>Muat ulang</Button>}
      />
      <DataTable
        caption="Daftar pencarian outlet lain"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.loading && rows.length === 0}
        error={q.error ? 'Log pencarian gagal dimuat.' : null}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<SearchCheck />} title="Belum ada pencarian tercatat" />}
        columnPrefsKey="mandalika.bo.crossOutletLookups.columns"
        footer={
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
          />
        }
      />
    </div>
  )
}
