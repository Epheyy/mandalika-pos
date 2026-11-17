import { useState } from 'react'
import type { Order } from '@mandalika/api'
import { ApiError } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { api } from '../../api'
import { BRAND } from '../../lib/brand'
import { voidModeLabel, voidReasonLabel } from '../../lib/labels/void'
import { Button } from '../../ui/Button'

interface Props {
  order: Order
  canVoid: boolean
  onDone: () => Promise<void> | void
}

/** Who/when/why a sale was voided, what became of it, and "Tandai tanpa pengganti" while a `later` void waits for its replacement. */
export function OrderVoidInfo({ order, canVoid, onDone }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const v = order.void
  if (!v) return null
  const awaiting = canVoid && v.mode === 'later' && !v.followup

  const mark = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.markVoidNoReplacement(order.id)
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof ApiError && e.message ? e.message : 'Gagal menandai. Coba lagi.')
      await onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1 rounded-xl bg-danger-bg p-3" data-testid="order-void-info">
      <p className="text-xs font-black text-danger">Dibatalkan</p>
      <p className="text-sm text-danger">
        {voidReasonLabel(v.reasonCode)}{v.note ? `: ${v.note}` : ''}
      </p>
      <p className="text-xs text-danger">
        {format(parseISO(v.voidedAt), 'dd MMM yyyy HH:mm', { locale: idLocale })}
        {v.voidedByName ? ` · ${v.voidedByName}` : ''} · {v.source === 'pos' ? 'POS' : 'Backoffice'}{v.afterClose ? ' · dikoreksi setelah ditutup' : ''}
      </p>
      <p className="text-xs text-danger">{voidModeLabel(v.mode)}</p>
      {v.replacementOrderNumber && <p className="text-xs text-danger">Pengganti: {v.replacementOrderNumber}</p>}
      {v.followup === 'no_replacement' && <p className="text-xs text-danger">Tanpa pengganti</p>}
      {v.mode === 'later' && !v.followup && <p className="text-xs text-danger">Menunggu pengganti dari POS</p>}
      {awaiting && (
        <Button variant="secondary" size="sm" loading={busy} onClick={() => void mark()}>Tandai tanpa pengganti</Button>
      )}
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </div>
  )
}

/** Shown on a replacement sale: which order it replaces and its Penyesuaian koreksi. */
export function OrderReplacementInfo({ order }: { order: Order }) {
  if (!order.replacesOrderNumber) return null
  const adj = order.correctionAmount ?? 0
  return (
    <div className="rounded-xl bg-info-bg p-3 text-sm text-info">
      <p>Pengganti untuk {order.replacesOrderNumber}</p>
      {adj !== 0 && <p>Penyesuaian koreksi {adj < 0 ? '-' : '+'}{BRAND.currency.format(Math.abs(adj))}</p>}
    </div>
  )
}
