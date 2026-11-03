import { useRef, useState } from 'react'
import type { AdjustmentRequest, ApprovalQueueItem, StockCount } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { api } from '../../api'
import { useAuth } from '../../auth'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import {
  countDetailRows,
  newIdempotencyKey,
  reasonLabel,
  signed,
} from '../../lib/inventoryApproval'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Textarea } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { adjustmentStrip, type AdjustmentStrip } from './approvalStrip'
import { PinModal } from './PinModal'

interface ApprovalDetailProps {
  item: ApprovalQueueItem
  onClose: () => void
  /** Called after an approve or reject succeeded. */
  onDone: () => void | Promise<void>
}

const fmt = (iso?: string) => (iso ? format(parseISO(iso), 'dd MMM yyyy HH:mm') : '-')

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-gray-400">{k}</span>
      <span className="font-bold text-gray-900 text-right">{v}</span>
    </div>
  )
}

function Strip({ strip }: { strip: AdjustmentStrip }) {
  return (
    <dl className="grid grid-cols-3 gap-3" aria-label="Perbandingan stok">
      {strip.cells.map((c) => (
        <div key={c.title} className="rounded-xl border border-gray-100 bg-paper-0 p-3">
          <dt className="text-xs font-bold text-ink-700">{c.title}</dt>
          <dd className="mt-1 text-2xl font-black tabular-nums text-gray-900">{c.value}</dd>
          <dd className="mt-0.5 text-xs text-ink-700">{c.note}</dd>
        </div>
      ))}
    </dl>
  )
}

function AdjustmentBody({ r }: { r: AdjustmentRequest }) {
  const strip = adjustmentStrip(r)
  return (
    <div className="space-y-2">
      <Row k="Produk" v={`${r.productName ?? r.productId} · ${r.variantSize}`} />
      <Strip strip={strip} />
      <Row k="Alasan" v={reasonLabel(r.reasonCode)} />
      {r.reasonText && <Row k="Keterangan" v={r.reasonText} />}
      {strip.goesNegative && (
        <p role="alert" className="text-xs font-bold text-red-700 bg-red-50 rounded-xl p-3">Stok akan menjadi minus: {strip.resultingQty}</p>
      )}
      {strip.drifted && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded-xl p-3">
          Stok berubah sejak pengajuan. Yang diterapkan adalah selisih ({signed(strip.delta)}), bukan jumlah baru.
        </p>
      )}
      {(r.events ?? []).length > 0 && (
        <div className="pt-2 border-t border-gray-100">
          <p className="text-xs font-black text-gray-400 uppercase mb-1">Riwayat</p>
          {(r.events ?? []).map((e) => (
            <p key={e.id} className="text-xs text-gray-600">{fmt(e.at)} · {e.action} · {e.actorName ?? '-'}{e.note ? ` · ${e.note}` : ''}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function CountBody({ c }: { c: StockCount }) {
  const lines = countDetailRows(c.items)
  return (
    <div className="space-y-2">
      <Row k="Alasan opname" v={reasonLabel(c.reasonCode)} />
      {c.reasonText && <Row k="Keterangan" v={c.reasonText} />}
      {c.rejectedNote && <p className="text-xs text-red-700 bg-red-50 rounded-xl p-3">Ditolak sebelumnya: {c.rejectedNote}</p>}
      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <table className="w-full">
          <thead className="bg-gray-50 sticky top-0">
            <tr>{['Produk', 'Varian', 'Acuan', 'Aktual', 'Selisih', 'Alasan'].map((h) => (
              <th key={h} className="text-left px-3 py-1.5 text-xs font-black text-gray-400 uppercase">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {lines.map(({ item: i, diff, reference }) => (
              <tr key={`${i.productId}|${i.variantSize}`}>
                <td className="px-3 py-1.5 text-sm font-bold text-gray-900">{i.productName}</td>
                <td className="px-3 py-1.5 text-xs text-gray-600">{i.variantSize}</td>
                <td className="px-3 py-1.5 text-sm">{reference}</td>
                <td className="px-3 py-1.5 text-sm">{i.actualQty ?? '-'}</td>
                <td className="px-3 py-1.5 text-sm font-black">{signed(diff)}</td>
                <td className="px-3 py-1.5 text-xs text-gray-600">
                  {i.reasonCode ? reasonLabel(i.reasonCode) : '-'}{i.reasonText ? `: ${i.reasonText}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Detail + actions for one queue item (adjustment request or submitted stock count). */
export function ApprovalDetail({ item, onClose, onDone }: ApprovalDetailProps) {
  const { user } = useAuth()
  const isAdj = item.type === 'adjustment'
  const dq = usePolledQuery<AdjustmentRequest | StockCount>(
    () => (isAdj ? api.getAdjustmentRequest(item.id) : api.getStockCount(item.id)),
    [item.id, item.type],
    30000,
  )
  const [pinOpen, setPinOpen] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const rejectKey = useRef(newIdempotencyKey())

  const isOwn = !!user && item.requestedBy === user.id

  const approve = async (pin: string, n: string, key: string) => {
    if (isAdj) await api.approveAdjustmentRequest(item.id, { pin, note: n || undefined }, key)
    else await api.approveStockCount(item.id, { pin, note: n || undefined }, key)
    setPinOpen(false)
    await onDone()
  }

  const reject = async () => {
    setBusy(true)
    setErr(null)
    try {
      if (isAdj) await api.rejectAdjustmentRequest(item.id, { note: note.trim() }, rejectKey.current)
      else await api.rejectStockCount(item.id, { note: note.trim() }, rejectKey.current)
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menolak.')
    } finally {
      setBusy(false)
    }
  }

  const d = dq.data
  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="xl"
        title={`${isAdj ? 'Penyesuaian' : 'Opname'} ${item.number ?? ''}`}
        subtitle={`${item.locationName ?? ''} · diajukan ${item.requestedByName ?? '-'} · ${fmt(item.at)}`}
        footer={
          rejecting ? (
            <>
              <Button variant="secondary" className="flex-1" onClick={() => setRejecting(false)}>Kembali</Button>
              <Button className="flex-1" loading={busy} disabled={!note.trim()} onClick={reject}>Konfirmasi Tolak</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" className="flex-1" onClick={() => setRejecting(true)}>Tolak</Button>
              <Button className="flex-1" disabled={isOwn || !d} onClick={() => setPinOpen(true)}>Setujui</Button>
            </>
          )
        }
      >
        <div className="space-y-4">
          {isOwn && <Badge tone="warning">Pengajuan Anda sendiri. Tidak bisa disetujui oleh pengaju.</Badge>}
          {dq.error && <p role="alert" className="text-sm text-red-600">{dq.error}</p>}
          {!d && !dq.error && <p className="text-sm text-gray-400">Memuat...</p>}
          {d && (isAdj ? <AdjustmentBody r={d as AdjustmentRequest} /> : <CountBody c={d as StockCount} />)}
          {rejecting && (
            <Textarea label="Alasan penolakan *" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          )}
          {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>
      {pinOpen && <PinModal title="Setujui" onApprove={approve} onClose={() => setPinOpen(false)} />}
    </>
  )
}
