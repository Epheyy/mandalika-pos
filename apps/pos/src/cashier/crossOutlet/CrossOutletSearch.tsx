import { useState } from 'react'
import type { CrossOutletOrder } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { api } from '../../api'
import { Button } from '../../components/ui/Button'
import { StatusBadge } from '../../components/ui/StatusBadge'
import type { Tone } from '../../components/ui/tone'
import { formatHistoryStamp } from '../historyStamp'
import { formatRupiah } from '../pricing'
import { CROSS_OFFLINE_SEARCH, lookupCrossOutlet, lookupQuery } from './crossOutletLookup'

const STATUS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: 'Selesai', tone: 'ok' },
  partially_refunded: { label: 'Sebagian refund', tone: 'warn' },
  refunded: { label: 'Sudah direfund', tone: 'danger' },
}

interface Props {
  isOnline: boolean
  /** The user may refund AND a synced open shift exists at this outlet (the server decides again). */
  canRefund: boolean
  onRefund: (row: CrossOutletOrder) => void
}

function ResultCard({ row, canRefund, onRefund }: { row: CrossOutletOrder; canRefund: boolean; onRefund: (r: CrossOutletOrder) => void }) {
  const o = row.order
  const st = STATUS[o.status] ?? { label: o.status, tone: 'neutral' as Tone }
  return (
    <div className="surface-card rounded-control p-4 space-y-2" data-testid="cross-outlet-result">
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 rounded-tag bg-paper-1 text-xs font-semibold text-ink-900">{row.outletName}</span>
        <p className="font-semibold text-sm text-ink-900 truncate">#{o.orderNumber}</p>
        <StatusBadge tone={st.tone} label={st.label} className="ml-auto" />
      </div>
      <p className="text-xs text-ink-500">{formatHistoryStamp(o.clientCreatedAt ?? o.createdAt)}</p>
      <div className="space-y-1">
        {o.items.map((it, n) => (
          <div key={`${it.lineNo ?? n}-${it.productId}-${it.variantSize}`} className="flex justify-between text-xs text-ink-700">
            <span>
              {it.productName}{variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''} ×{it.quantity}
              {(it.refundedQty ?? 0) > 0 ? <span className="text-danger"> · {it.refundedQty} direfund</span> : null}
            </span>
            <span>{formatRupiah(it.subtotal)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-sm font-bold text-ink-900 border-t border-dashed border-paper-2 pt-2">
        <span>Total</span><span>{formatRupiah(o.total)}</span>
      </div>
      {(o.refundedAmount ?? 0) > 0 && <p className="text-xs text-danger">Sudah direfund {formatRupiah(o.refundedAmount ?? 0)}</p>}
      {canRefund && o.status !== 'refunded' && (
        <Button variant="secondary" fullWidth onClick={() => onRefund(row)}>Refund di outlet ini</Button>
      )}
    </div>
  )
}

/** "Outlet lain" tab of Riwayat (A18): exact order number or phone, online only. Results live in memory only (A30). */
export function CrossOutletSearch({ isOnline, canRefund, onRefund }: Props) {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<CrossOutletOrder[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async () => {
    if (!isOnline || !lookupQuery(text)) return
    setLoading(true)
    setError(null)
    try {
      setRows(await lookupCrossOutlet(api, text))
    } catch (e) {
      setRows(null)
      setError(e instanceof Error ? e.message : 'Gagal mencari transaksi')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3" data-testid="cross-outlet-search">
      <form className="flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); void search() }}>
        <div className="flex-1">
          <label htmlFor="cross-outlet-q" className="block text-xs text-ink-700 font-semibold mb-1">No. order atau nomor HP</label>
          <input id="cross-outlet-q" type="text" value={text} disabled={!isOnline} placeholder={isOnline ? 'Nomor order lengkap atau nomor HP' : CROSS_OFFLINE_SEARCH}
            onChange={(e) => setText(e.target.value)}
            className="w-full min-h-11 surface-card rounded-control px-3 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong disabled:opacity-50" />
        </div>
        <Button type="submit" disabled={!isOnline || loading || !lookupQuery(text)}>{loading ? 'Mencari…' : 'Cari'}</Button>
      </form>
      {!isOnline && <p className="text-xs font-semibold text-warn-strong bg-warn-bg rounded-control px-3 py-2" role="status">{CROSS_OFFLINE_SEARCH}. Refund outlet lain hanya bisa online.</p>}
      {error && <p className="text-sm text-danger text-center py-2">{error}</p>}
      {rows !== null && rows.length === 0 && !error && <p className="text-sm text-ink-500 py-6 text-center">Tidak ada transaksi yang cocok di outlet lain</p>}
      {rows?.map((r) => <ResultCard key={r.order.id} row={r} canRefund={canRefund && isOnline} onRefund={onRefund} />)}
    </div>
  )
}
