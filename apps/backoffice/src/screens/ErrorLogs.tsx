import { useState } from 'react'
import { fetchAllPages, type ErrorLog, type ListResult } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { AlertTriangle } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { exportToCSV, exportToXLSX, buildExportName } from '../lib/csvUtils'
import { ERROR_SOURCE } from '../lib/labels/errorSource'
import { labelOf } from '../lib/labels/types'
import { Button } from '../ui/Button'
import { DataTable, type Column } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { ExportButton, type ExportFormat } from '../ui/ExportButton'
import { FilterBar } from '../ui/FilterBar'
import { PageHeader } from '../ui/PageHeader'
import { Pagination } from '../ui/Pagination'
import { SlideOver } from '../ui/SlideOver'
import { StatusBadge } from '../ui/StatusBadge'

const SOURCE_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Semua Sumber' },
  ...Object.keys(ERROR_SOURCE).map((k) => ({ id: k, label: labelOf(ERROR_SOURCE, k).label })),
]

const DASH = '—'

function fmtTime(s?: string | null): string {
  if (!s) return DASH
  try {
    return format(parseISO(s), 'dd MMM yyyy HH:mm:ss', { locale: id })
  } catch {
    return s
  }
}

export default function ErrorLogs() {
  const [source, setSource] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  // The clicked row itself, not an id into the polled page: a new error pushing it off page 1 must not close the panel.
  const [opened, setOpened] = useState<ErrorLog | null>(null)

  const q = usePolledQuery<ListResult<ErrorLog>>(
    () =>
      api.listErrorLogs({
        page,
        limit: pageSize,
        ...(source ? { source } : {}),
      }),
    [page, pageSize, source],
  )
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const exportErrorLogs = async (fmt: ExportFormat) => {
    const all = await fetchAllPages((page, limit) =>
      api.listErrorLogs({ page, limit, ...(source ? { source } : {}) }))
    const exportRows = all.map((e) => ({
      Sumber: e.source,
      Jenis: e.kind ?? '',
      Pesan: e.message,
      Aksi: e.action ?? '',
      Outlet: e.outletName ?? e.outletId ?? '',
      Pengguna: e.userName ?? e.userId ?? '',
      Perangkat: e.deviceId ?? '',
      Versi: e.appVersion ?? '',
      Waktu: fmtTime(e.createdAt),
    }))
    const name = buildExportName('log-kesalahan', [source || undefined])
    if (fmt === 'csv') exportToCSV(exportRows, name)
    else exportToXLSX(exportRows, name)
  }

  const columns: Column<ErrorLog>[] = [
    { id: 'time', header: 'Waktu', cell: (e) => fmtTime(e.createdAt) },
    { id: 'source', header: 'Sumber', cell: (e) => <StatusBadge map={ERROR_SOURCE} value={e.source} /> },
    { id: 'kind', header: 'Jenis', cell: (e) => e.kind ?? DASH },
    { id: 'message', header: 'Pesan', cell: (e) => <span className="line-clamp-2 font-bold">{e.message}</span> },
    { id: 'outlet', header: 'Outlet', cell: (e) => e.outletName ?? DASH },
    { id: 'user', header: 'Pengguna', cell: (e) => e.userName ?? DASH, defaultHidden: true },
    { id: 'device', header: 'Perangkat', cell: (e) => e.deviceId ?? DASH, defaultHidden: true },
  ]

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Log Kesalahan"
        count={`${total} kesalahan`}
        subtitle="Sinkron, runtime, cetak dan backend, termasuk aktivitas pengguna, outlet dan perangkat."
        actions={
          <>
            <ExportButton
              formats={['csv', 'xlsx']}
              rowCount={q.data ? total : null}
              filterSummary={source ? [`Sumber: ${labelOf(ERROR_SOURCE, source).label}`] : []}
              onExport={exportErrorLogs}
              disabled={total === 0}
            />
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Muat ulang
            </Button>
          </>
        }
      />

      <FilterBar onReset={() => { setSource(''); setPage(1) }} activeCount={source ? 1 : 0}>
        <FilterBar.Chips
          label="Sumber kesalahan"
          items={SOURCE_FILTERS}
          value={source}
          onChange={(v) => { setSource(v); setPage(1) }}
        />
      </FilterBar>

      <DataTable
        caption="Daftar log kesalahan"
        columns={columns}
        rows={rows}
        rowKey={(e) => e.id}
        loading={q.loading && rows.length === 0}
        error={q.error ? 'Log kesalahan gagal dimuat.' : null}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<AlertTriangle />} title="Tidak ada kesalahan tercatat" />}
        onRowClick={setOpened}
        selectedKey={opened?.id ?? null}
        columnPrefsKey="mandalika.bo.errorLogs.columns"
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

      <SlideOver
        open={opened !== null}
        onClose={() => setOpened(null)}
        title="Detail Kesalahan"
        subtitle={opened ? `${labelOf(ERROR_SOURCE, opened.source).label}${opened.kind ? ` · ${opened.kind}` : ''}` : undefined}
        width="lg"
        dirty={false}
      >
        {opened && <ErrorDetail e={opened} />}
      </SlideOver>
    </div>
  )
}

function ErrorDetail({ e }: { e: ErrorLog }) {
  return (
    <div className="space-y-4">
      <p className="font-bold text-gray-900 break-words">{e.message}</p>
      {e.action && <DetailField label="Aksi" value={e.action} />}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <DetailField label="Outlet" value={e.outletName ?? e.outletId ?? DASH} />
        <DetailField label="Pengguna" value={e.userName ?? e.userId ?? DASH} />
        <DetailField label="Perangkat" value={e.deviceId ?? DASH} />
        <DetailField label="Versi" value={e.appVersion ?? DASH} />
        <DetailField label="Terjadi" value={fmtTime(e.clientCreatedAt)} />
        <DetailField label="Tercatat" value={fmtTime(e.createdAt)} />
      </div>

      {e.breadcrumbs && e.breadcrumbs.length > 0 && (
        <div>
          <p className="text-xs font-black text-ink-700 uppercase tracking-widest mb-2">Aktivitas Sebelum Kesalahan</p>
          <ol className="space-y-1">
            {e.breadcrumbs.map((b, i) => (
              <li key={`${b.at}-${b.label}-${i}`} className="flex gap-2 text-xs">
                <span className="text-ink-700 font-mono flex-shrink-0">{fmtTime(b.at).slice(-8)}</span>
                <span className="text-gray-700">{b.label}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {e.payload != null && (
        <div>
          <p className="text-xs font-black text-ink-700 uppercase tracking-widest mb-2">Detail teknis</p>
          <pre className="text-[11px] bg-gray-900 text-gray-100 rounded-xl p-3 overflow-x-auto max-h-64">
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-black text-ink-700 uppercase tracking-wider">{label}</p>
      <p className="text-gray-800 font-semibold break-words">{value}</p>
    </div>
  )
}
