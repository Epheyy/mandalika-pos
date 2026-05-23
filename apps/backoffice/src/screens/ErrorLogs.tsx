import { useState } from 'react'
import type { ErrorLog, ListResult } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'

const PAGE_SIZE = 50

const SOURCES = [
  { id: '', label: 'Semua Sumber' },
  { id: 'sync', label: 'Sync' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'print', label: 'Cetak' },
  { id: 'backend', label: 'Backend' },
]

const SOURCE_STYLE: Record<string, string> = {
  sync: 'bg-amber-50 text-amber-700',
  runtime: 'bg-red-50 text-red-600',
  print: 'bg-blue-50 text-blue-700',
  backend: 'bg-purple-50 text-purple-700',
}

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
  const [expanded, setExpanded] = useState<string | null>(null)

  const q = usePolledQuery<ListResult<ErrorLog>>(
    () =>
      api.listErrorLogs({
        page,
        limit: PAGE_SIZE,
        ...(source ? { source } : {}),
      }),
    [page, source],
  )
  const rows = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="p-6 space-y-5">
      <div>
        <h2 className="text-xl font-black text-gray-900">Log Error</h2>
        <p className="text-sm text-gray-400">
          {total} error · sync / runtime / cetak / backend — termasuk aktivitas pengguna, outlet & perangkat.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select
          value={source}
          onChange={(e) => { setSource(e.target.value); setPage(1) }}
          className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none"
        >
          {SOURCES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <button
          onClick={() => void q.refetch()}
          className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-50"
        >
          Muat ulang
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {q.loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
            <AlertTriangle className="w-12 h-12" />
            <p className="font-bold">Tidak ada error tercatat</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {rows.map((e) => {
              const open = expanded === e.id
              return (
                <div key={e.id}>
                  <div
                    className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 cursor-pointer"
                    onClick={() => setExpanded(open ? null : e.id)}
                  >
                    <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                      <AlertTriangle className="w-4 h-4 text-red-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 text-[10px] font-bold rounded-lg uppercase ${SOURCE_STYLE[e.source] ?? 'bg-gray-100 text-gray-500'}`}>
                          {e.source}{e.kind ? ` · ${e.kind}` : ''}
                        </span>
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
                        <Field label="Outlet" value={e.outletName ?? e.outletId ?? '—'} />
                        <Field label="Pengguna" value={e.userName ?? e.userId ?? '—'} />
                        <Field label="Perangkat" value={e.deviceId ?? '—'} />
                        <Field label="Versi" value={e.appVersion ?? '—'} />
                        <Field label="Terjadi" value={fmtTime(e.clientCreatedAt)} />
                        <Field label="Tercatat" value={fmtTime(e.createdAt)} />
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
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">Hal {page}/{totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 disabled:opacity-40 hover:bg-gray-50"
            >
              ‹ Sebelumnya
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 disabled:opacity-40 hover:bg-gray-50"
            >
              Berikutnya ›
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-gray-800 font-semibold break-words">{value}</p>
    </div>
  )
}
