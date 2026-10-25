import type { StockRequisition } from '@mandalika/api'
import { REQUISITION_STATUS, STATUS_FILTERS, fmtDate, type RequisitionStatus } from './requisitionLabels'

const TONE: Record<string, string> = {
  neutral: 'bg-gray-100 text-gray-600',
  warning: 'bg-amber-100 text-amber-700',
  success: 'bg-green-100 text-green-700',
  danger: 'bg-red-100 text-red-700',
  gold: 'bg-yellow-100 text-yellow-800',
}

export function StatusBadge({ status }: { status: RequisitionStatus }) {
  const meta = REQUISITION_STATUS[status]
  return <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${TONE[meta.tone]}`}>{meta.label}</span>
}

interface Props {
  rows: StockRequisition[]
  loading: boolean
  /** A user-facing failure (offline, forbidden, feature off, retry). */
  error: string | null
  /** A notice from an earlier action (e.g. a requisition that may already be saved). */
  notice?: string | null
  /** An action is in flight (e.g. the open-time resolve): new requests and row taps wait. */
  busy?: boolean
  filter: RequisitionStatus | ''
  onFilter: (f: RequisitionStatus | '') => void
  onOpen: (id: string) => void
  onNew: () => void
  onReload: () => void
}

export function RequisitionList({ rows, loading, error, notice, busy = false, filter, onFilter, onOpen, onNew, onReload }: Props) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b flex gap-2 overflow-x-auto">
        {STATUS_FILTERS.map((f) => (
          <button
            type="button" key={f.value || 'all'} onClick={() => onFilter(f.value)}
            className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap ${filter === f.value ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {notice && <p role="status" className="px-4 py-2 text-sm text-amber-800 bg-amber-50 border-b border-amber-100">{notice}</p>}
      <div className="px-4 py-2 flex gap-2 border-b">
        <button type="button" onClick={onNew} disabled={busy} className="flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-bold disabled:opacity-50">Buat Permintaan</button>
        <button type="button" onClick={onReload} disabled={loading || busy} className="px-3 text-sm text-indigo-600 font-bold disabled:text-gray-300">Muat ulang</button>
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <p className="text-sm text-red-600">{error}</p>
            <button type="button" onClick={onReload} className="mt-2 text-sm font-bold text-indigo-600">Coba Lagi</button>
          </div>
        ) : loading && rows.length === 0 ? <p className="p-4 text-sm text-gray-400">Memuat…</p>
          : rows.length === 0 ? <p className="p-4 text-sm text-gray-400">Belum ada permintaan barang dari outlet ini.</p>
          : rows.map((r) => (
            <button type="button" key={r.id} onClick={() => onOpen(r.id)} disabled={busy} className="w-full text-left px-4 py-3 border-b hover:bg-gray-50 disabled:opacity-60">
              <div className="flex justify-between items-center">
                <span className="font-bold text-gray-800 text-sm">{r.number}</span>
                <StatusBadge status={r.status} />
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                Dibutuhkan: {fmtDate(r.neededBy)} · Dibuat oleh {r.requestedByName ?? '—'}
              </div>
              {r.transfer && (
                <div className="text-xs text-gray-500">Transfer {r.transfer.transferNo} · {r.transfer.status}</div>
              )}
            </button>
          ))}
      </div>
    </div>
  )
}
