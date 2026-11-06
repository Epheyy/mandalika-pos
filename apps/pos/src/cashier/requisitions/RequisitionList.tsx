import type { StockRequisition } from '@mandalika/api'
import { Button } from '../../components/ui/Button'
import { Chip } from '../../components/ui/Chip'
import { StatusBadge as KitStatusBadge } from '../../components/ui/StatusBadge'
import type { Tone } from '../../components/ui/tone'
import { REQUISITION_STATUS, STATUS_FILTERS, fmtDate, type RequisitionStatus } from './requisitionLabels'

const TONE: Record<string, Tone> = {
  neutral: 'neutral',
  warning: 'warn',
  success: 'ok',
  danger: 'danger',
  gold: 'brand',
}

export function StatusBadge({ status }: { status: RequisitionStatus }) {
  const meta = REQUISITION_STATUS[status]
  return <KitStatusBadge tone={TONE[meta.tone]} label={meta.label} />
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
      <div className="px-4 py-2 border-b border-paper-2 flex gap-2 overflow-x-auto">
        {STATUS_FILTERS.map((f) => (
          <Chip key={f.value || 'all'} selected={filter === f.value} onClick={() => onFilter(f.value)} className="whitespace-nowrap">
            {f.label}
          </Chip>
        ))}
      </div>
      {notice && <p role="status" className="px-4 py-2 text-sm text-warn-strong bg-warn-bg border-b border-paper-2">{notice}</p>}
      <div className="px-4 py-2 flex gap-2 border-b border-paper-2">
        <Button onClick={onNew} disabled={busy} className="flex-1">Buat Permintaan</Button>
        <Button variant="ghost" onClick={onReload} disabled={loading || busy} className="px-3 !text-brand-strong">Muat ulang</Button>
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <p className="text-sm text-danger">{error}</p>
            <Button variant="secondary" onClick={onReload} className="mt-2">Coba Lagi</Button>
          </div>
        ) : loading && rows.length === 0 ? <p className="p-4 text-sm text-ink-500">Memuat…</p>
          : rows.length === 0 ? <p className="p-4 text-sm text-ink-500">Belum ada permintaan barang dari outlet ini.</p>
          : rows.map((r) => (
            <button type="button" key={r.id} onClick={() => onOpen(r.id)} disabled={busy} className="press w-full min-h-11 text-left px-4 py-3 border-b border-paper-2 active:bg-paper-1 disabled:opacity-60">
              <div className="flex justify-between items-center">
                <span className="font-bold text-ink-900 text-sm">{r.number}</span>
                <StatusBadge status={r.status} />
              </div>
              <div className="text-xs text-ink-700 mt-0.5">
                Dibutuhkan: {fmtDate(r.neededBy)} · Dibuat oleh {r.requestedByName ?? '—'}
              </div>
              {r.transfer && (
                <div className="text-xs text-ink-700">Transfer {r.transfer.transferNo} · {r.transfer.status}</div>
              )}
            </button>
          ))}
      </div>
    </div>
  )
}
