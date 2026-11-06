import { useState } from 'react'
import type { StockRequisition } from '@mandalika/api'
import { StatusBadge } from './RequisitionList'
import { Button } from '../../components/ui/Button'
import { EVENT_LABEL, allowedActions, buildChain, fmtDate, fmtDateTime } from './requisitionLabels'

const STEP_STYLE = {
  done: 'bg-brand-strong text-on-brand',
  current: 'bg-paper-1 text-brand-strong ring-2 ring-brand-strong',
  todo: 'bg-paper-1 text-ink-700',
} as const

interface Props {
  pb: StockRequisition
  /** An action in flight; disables the buttons. */
  busy: boolean
  /** A user-facing failure or notice for the last action. */
  message: string | null
  /** Set when the last failure was "server belum menjawab": re-sends the same action (same key). */
  onRetry?: (() => void) | null
  onEdit: () => void
  onSubmit: () => void
  onCancel: () => void
  onOpenReceive: () => void
}

export function RequisitionDetail({ pb, busy, message, onRetry, onEdit, onSubmit, onCancel, onOpenReceive }: Props) {
  const [confirmCancel, setConfirmCancel] = useState(false)
  const chain = buildChain(pb)
  const can = allowedActions(pb)
  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center">
        <span className="font-bold text-ink-900">{pb.number}</span>
        <StatusBadge status={pb.status} />
      </div>

      {chain.deadEnd ? (
        <div className="rounded-control bg-danger-bg p-3 text-sm">
          <div className="font-bold text-danger">{chain.deadEnd.label}</div>
          {chain.deadEnd.note && <div className="text-danger mt-0.5">{chain.deadEnd.note}</div>}
        </div>
      ) : (
        <ol className="flex flex-wrap gap-1.5">
          {chain.steps.map((s) => (
            <li key={s.key} className={`px-2.5 py-1 rounded-full text-xs font-bold ${STEP_STYLE[s.state]}`}>
              {s.label}{s.note ? ` · ${s.note}` : ''}
            </li>
          ))}
        </ol>
      )}

      <div className="text-xs text-ink-700 space-y-0.5">
        <div>Dibutuhkan: {fmtDate(pb.neededBy)}</div>
        {pb.warehouseName && <div>Gudang asal: {pb.warehouseName}</div>}
        {pb.transfer && <div>Transfer: {pb.transfer.transferNo}</div>}
        {pb.note && <div className="whitespace-pre-line text-ink-900">Catatan: {pb.note}</div>}
      </div>

      <div>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[11px] font-bold text-ink-500 pb-1 border-b border-paper-2">
          <span>Barang</span><span>Diminta</span><span>Disetujui</span><span>Dikirim</span>
        </div>
        {(pb.items ?? []).map((it) => (
          <div key={it.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 tnum text-sm py-1 border-b border-paper-1">
            <span className="text-ink-900">{it.productName ?? '—'} · {it.variantSize}{it.sku ? ` (${it.sku})` : ''}</span>
            <span className="text-right">{it.requestedQty}</span>
            <span className="text-right">{it.approvedQty ?? '—'}</span>
            <span className="text-right">{it.transferQty ?? '—'}</span>
          </div>
        ))}
      </div>

      {message && <p className="text-sm text-danger">{message}</p>}
      {message && onRetry && (
        <Button variant="secondary" disabled={busy} onClick={onRetry}>Coba Lagi</Button>
      )}

      {confirmCancel ? (
        <div className="rounded-control bg-warn-bg p-3 space-y-2">
          <p className="text-sm text-warn-strong">Batalkan {pb.number}? Permintaan yang dibatalkan tidak bisa dibuka lagi.</p>
          <div className="flex gap-2">
            <Button variant="danger" disabled={busy} onClick={() => { setConfirmCancel(false); onCancel() }} className="flex-1">Batalkan Permintaan</Button>
            <Button variant="secondary" onClick={() => setConfirmCancel(false)} className="flex-1">Kembali</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {can.submit && <Button disabled={busy} onClick={onSubmit}>Ajukan</Button>}
          {can.edit && <Button variant="secondary" disabled={busy} onClick={onEdit}>Ubah</Button>}
          {can.openReceive && <Button onClick={onOpenReceive}>Buka Terima Transfer</Button>}
          {can.cancel && <Button variant="ghost" disabled={busy} onClick={() => setConfirmCancel(true)} className="!text-danger">Batalkan Permintaan</Button>}
        </div>
      )}

      <div>
        <div className="text-xs font-bold text-ink-500 mb-1">Riwayat</div>
        {(pb.events ?? []).map((e) => (
          <div key={e.id} className="text-xs text-ink-700 py-0.5">
            {fmtDateTime(e.at)} · {EVENT_LABEL[e.action] ?? e.action}{e.actorName ? ` oleh ${e.actorName}` : ''}{e.note ? ` — ${e.note}` : ''}
          </div>
        ))}
      </div>
    </div>
  )
}
