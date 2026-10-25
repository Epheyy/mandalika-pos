import { useState } from 'react'
import type { StockRequisition } from '@mandalika/api'
import { StatusBadge } from './RequisitionList'
import { EVENT_LABEL, allowedActions, buildChain, fmtDate, fmtDateTime } from './requisitionLabels'

const STEP_STYLE = {
  done: 'bg-indigo-600 text-white',
  current: 'bg-indigo-100 text-indigo-700 ring-2 ring-indigo-600',
  todo: 'bg-gray-100 text-gray-400',
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
        <span className="font-bold text-gray-900">{pb.number}</span>
        <StatusBadge status={pb.status} />
      </div>

      {chain.deadEnd ? (
        <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-sm">
          <div className="font-bold text-red-700">{chain.deadEnd.label}</div>
          {chain.deadEnd.note && <div className="text-red-600 mt-0.5">{chain.deadEnd.note}</div>}
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

      <div className="text-xs text-gray-600 space-y-0.5">
        <div>Dibutuhkan: {fmtDate(pb.neededBy)}</div>
        {pb.warehouseName && <div>Gudang asal: {pb.warehouseName}</div>}
        {pb.transfer && <div>Transfer: {pb.transfer.transferNo}</div>}
        {pb.note && <div className="whitespace-pre-line text-gray-700">Catatan: {pb.note}</div>}
      </div>

      <div>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[11px] font-bold text-gray-400 pb-1 border-b">
          <span>Barang</span><span>Diminta</span><span>Disetujui</span><span>Dikirim</span>
        </div>
        {(pb.items ?? []).map((it) => (
          <div key={it.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-sm py-1 border-b border-gray-50">
            <span className="text-gray-800">{it.productName ?? '—'} · {it.variantSize}{it.sku ? ` (${it.sku})` : ''}</span>
            <span className="text-right">{it.requestedQty}</span>
            <span className="text-right">{it.approvedQty ?? '—'}</span>
            <span className="text-right">{it.transferQty ?? '—'}</span>
          </div>
        ))}
      </div>

      {message && <p className="text-sm text-red-600">{message}</p>}
      {message && onRetry && (
        <button type="button" disabled={busy} onClick={onRetry} className="border border-indigo-600 text-indigo-600 rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50">Coba Lagi</button>
      )}

      {confirmCancel ? (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
          <p className="text-sm text-amber-800">Batalkan {pb.number}? Permintaan yang dibatalkan tidak bisa dibuka lagi.</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => { setConfirmCancel(false); onCancel() }}
              className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm font-bold disabled:opacity-50">Batalkan Permintaan</button>
            <button type="button" onClick={() => setConfirmCancel(false)} className="flex-1 border rounded-lg py-2 text-sm font-bold text-gray-600">Kembali</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {can.submit && <button type="button" disabled={busy} onClick={onSubmit} className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50">Ajukan</button>}
          {can.edit && <button type="button" disabled={busy} onClick={onEdit} className="border rounded-lg px-4 py-2 text-sm font-bold text-gray-700 disabled:opacity-50">Ubah</button>}
          {can.openReceive && <button type="button" onClick={onOpenReceive} className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm font-bold">Buka Terima Transfer</button>}
          {can.cancel && <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)} className="border border-red-300 text-red-600 rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50">Batalkan Permintaan</button>}
        </div>
      )}

      <div>
        <div className="text-xs font-bold text-gray-400 mb-1">Riwayat</div>
        {(pb.events ?? []).map((e) => (
          <div key={e.id} className="text-xs text-gray-600 py-0.5">
            {fmtDateTime(e.at)} · {EVENT_LABEL[e.action] ?? e.action}{e.actorName ? ` oleh ${e.actorName}` : ''}{e.note ? ` — ${e.note}` : ''}
          </div>
        ))}
      </div>
    </div>
  )
}
