import { useState } from 'react'
import type { ErrorLog, ListResult } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { exportToCSV, exportToXLSX, buildExportName } from '../lib/csvUtils'
import { ImportExportBar } from '../components/ImportExportBar'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { Pagination } from '../ui/Pagination'


const SOURCES: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Semua Sumber' },
  { id: 'sync', label: 'Sync' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'print', label: 'Cetak' },
  { id: 'backend', label: 'Backend' },
]

type Tone = 'gold' | 'success' | 'danger' | 'neutral'

// Severity-by-source mapping (semantic only):
//   runtime → danger (crashes/runtime errors)
//   sync    → warning (amber, applied via className since Badge has no amber tone)
//   backend → gold (brand/server-side)
//   print   → neutral (info)
const SOURCE_TONE: Record<string, Tone> = {
  runtime: 'danger',
  backend: 'gold',
  print: 'neutral',
}
const SOURCE_WARNING = new Set(['sync'])

function fmtTime(s?: string | null): string {
  if (!s) return '—'
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
  const [expanded, setExpanded] = useState<string | null>(null)

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

  const exportErrorLogs = async (fmt: 'csv' | 'xlsx') => {
    const result = await api.listErrorLogs({
      page: 1,
      limit: 10000,
      ...(source ? { source } : {}),
    })
    const exportRows = result.data.map((e) => ({
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
    const name = buildExportName('log-error', [source || undefined])
    if (fmt === 'csv') exportToCSV(exportRows, name)
    else exportToXLSX(exportRows, name)
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Log Error"
        subtitle={`${total} error · sync / runtime / cetak / backend — termasuk aktivitas pengguna, outlet & perangkat.`}
        actions={
          <>
            <ImportExportBar
              onExport={(fmt) => void exportErrorLogs(fmt)}
              exportDisabled={total === 0}
            />
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Muat ulang
            </Button>
          </>
        }
      />

      <Tabs
        value={source}
        onChange={(v) => { setSource(v); setPage(1); }}
        tabs={SOURCES}
      />

      <Card className="overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState icon={<AlertTriangle />} title="Tidak ada error tercatat" />
        ) : (
          <div className="divide-y divide-gray-50">
            {rows.map((e) => {
              const open = expanded === e.id
              const isWarning = SOURCE_WARNING.has(e.source)
              const label = `${e.source}${e.kind ? ` · ${e.kind}` : ''}`
              return (
                <div key={e.id}>
                  <div
                    className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpanded(open ? null : e.id)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setExpanded(open ? null : e.id) } }}
                  >
                    <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                      <AlertTriangle className="w-4 h-4 text-red-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {isWarning ? (
                          // Badge has no amber tone; warnings use an amber span matching Badge shape.
                          <span className="px-2.5 py-1 text-xs font-bold rounded-lg uppercase bg-amber-50 text-amber-700">
                            {label}
                          </span>
                        ) : (
                          <Badge tone={SOURCE_TONE[e.source] ?? 'neutral'} className="uppercase">
                            {label}
                          </Badge>
                        )}
                        <p className="font-bold text-gray-900 text-sm truncate">{e.message}</p>
                      </div>
                      <p className="text-xs text-gray-400 truncate">
                        {e.action ? `${e.action} · ` : ''}
                        {e.outletName ?? 'Outlet ?'}
                        {e.userName ? ` · ${e.userName}` : ''}
                        {e.deviceId ? ` · ${e.deviceId}` : ''}
                        {' · '}{fmtTime(e.createdAt)}
                      </p>
                    </div>
                    {open ? <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                  </div>

                  {open && (
                    <div className="px-5 pb-5 bg-gray-50 border-t border-gray-100 pt-4 space-y-4">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        <DetailField label="Outlet" value={e.outletName ?? e.outletId ?? '—'} />
                        <DetailField label="Pengguna" value={e.userName ?? e.userId ?? '—'} />
                        <DetailField label="Perangkat" value={e.deviceId ?? '—'} />
                        <DetailField label="Versi" value={e.appVersion ?? '—'} />
                        <DetailField label="Terjadi" value={fmtTime(e.clientCreatedAt)} />
                        <DetailField label="Tercatat" value={fmtTime(e.createdAt)} />
                      </div>

                      {e.breadcrumbs && e.breadcrumbs.length > 0 && (
                        <div>
                          <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Aktivitas Sebelum Error</p>
                          <ol className="space-y-1">
                            {e.breadcrumbs.map((b, i) => (
                              <li key={i} className="flex gap-2 text-xs">
                                <span className="text-gray-400 font-mono flex-shrink-0">{fmtTime(b.at).slice(-8)}</span>
                                <span className="text-gray-700">{b.label}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {e.payload != null && (
                        <div>
                          <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Detail</p>
                          <pre className="text-[11px] bg-gray-900 text-gray-100 rounded-xl p-3 overflow-x-auto max-h-64">
                            {JSON.stringify(e.payload, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
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
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-gray-800 font-semibold break-words">{value}</p>
    </div>
  )
}
