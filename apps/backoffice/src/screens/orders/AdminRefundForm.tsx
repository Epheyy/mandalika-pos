import { useRef, useState } from 'react'
import type { Order } from '@mandalika/api'
import { ApiError } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { RotateCcw } from 'lucide-react'
import { api } from '../../api'
import { BRAND } from '../../lib/brand'
import { isSplitOrder, payoutChoices } from '../../lib/splitPayment'
import { Button } from '../../ui/Button'
import { Select, Textarea } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import {
  EMPTY_SELECTION, REASON_PRESETS, buildReason, canPartialRefundStatus, estimateRefund, isUncertainRefundStatus, lineLockReason,
  refundErrorMessage, remainingQty, remainingRefundable, selectionToItems, setLineQty, type Selection,
} from './refundSelection'

const money = (n: number) => BRAND.currency.format(n)

interface Props {
  order: Order
  /** Configured payment methods, to label the payout chips. */
  methods?: ReadonlyArray<{ id: string; label: string; isCash?: boolean | null; isEnabled?: boolean }>
  /** Called after a successful refund, or after a 409 so the caller reloads the order and list. */
  onDone: () => Promise<void> | void
}

/** Admin per-line refund (D-47). Legacy orders (lines without lineNo) only get the whole-order refund,
 *  and only while there is no earlier refund. */
export function AdminRefundForm({ order, methods, onDone }: Props) {
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const [code, setCode] = useState('')
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  // Payout chip of a split order; null = the D-56 default (cash if the sale had cash, else the largest line).
  const [payoutPick, setPayoutPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Replay key: one uuid per confirmed attempt, reused when the same selection+reason is retried.
  const attempt = useRef<{ key: string; uuid: string } | null>(null)

  if (!canPartialRefundStatus(order.status)) return null

  const legacy = order.items.some((i) => i.lineNo == null)
  const hadRefund = (order.refunds ?? []).length > 0 || order.status === 'partially_refunded'
  if (legacy && hadRefund) return null

  const reset = () => { attempt.current = null; setOpen(false); setSel(EMPTY_SELECTION); setCode(''); setText(''); setConfirming(false); setErr(null); setPayoutPick(null) }
  // Single-method orders pay out in the sale's method: no choice, nothing extra is sent.
  // The chips wait for the configured methods (the default depends on which are cash). Only an explicit pick is
  // sent; an untouched form sends nothing, so the server applies its own default and records it as such.
  const choices = methods && isSplitOrder(order) ? payoutChoices(order, methods) : null
  const shown = choices && choices.options.length > 0 ? (payoutPick ?? choices.defaultId) : ''
  const payout = payoutPick ?? ''
  const payoutLabel = choices?.options.find((c) => c.id === shown)?.label ?? shown
  const picked = selectionToItems(sel)
  const reasonRes = buildReason(code, text)
  // A legacy order has no lines to pick: the whole order is refunded.
  const readyItems = legacy || picked.length > 0
  const rawEstimate = legacy ? order.total : estimateRefund(order.items, sel)
  const remaining = remainingRefundable(order)
  const estimate = remaining === null ? rawEstimate : Math.min(rawEstimate, remaining)

  const askConfirm = () => {
    if (!readyItems) { setErr('Pilih minimal satu item untuk di-refund'); return }
    if (!reasonRes.ok) { setErr(reasonRes.error); return }
    setErr(null)
    setConfirming(true)
  }

  const submit = async () => {
    if (!reasonRes.ok) return
    setBusy(true)
    const key = JSON.stringify([legacy ? null : picked, reasonRes.reasonCode, reasonRes.reason, payout])
    if (attempt.current?.key !== key) attempt.current = { key, uuid: crypto.randomUUID() }
    try {
      await api.refundOrder(order.id, reasonRes.reason, {
        reasonCode: reasonRes.reasonCode,
        ...(legacy ? {} : { items: picked }),
        clientRefundUuid: attempt.current.uuid,
        ...(payout ? { payoutMethod: payout } : {}),
      })
      reset()
      await onDone()
    } catch (e: unknown) {
      const status = e instanceof ApiError ? e.status : 0
      setConfirming(false)
      setErr(refundErrorMessage(status, e instanceof Error ? e.message : ''))
      if (status === 409) setSel(EMPTY_SELECTION)
      if (status === 409 || isUncertainRefundStatus(status)) await onDone()
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}
        icon={<RotateCcw className="w-3.5 h-3.5" />}
      >
        Proses Refund
      </Button>
    )
  }

  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      {legacy ? (
        <p className="text-xs text-amber-700">Transaksi lama tanpa nomor baris: hanya bisa refund seluruh transaksi ({money(order.total)}).</p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Pilih item yang di-refund</p>
          {order.items.map((it) => {
            if (it.lineNo == null) return null
            const lineNo = it.lineNo
            const lock = lineLockReason(it, order.items)
            const max = remainingQty(it)
            const qty = sel[lineNo] ?? 0
            const label = `${it.productName}${variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''}`
            return (
              <div key={lineNo} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <p className="text-gray-700 truncate">{label} <span className="text-gray-400">sisa {max}/{it.quantity}</span></p>
                  {it.refundGroup && !lock && <p className="text-xs text-gray-400">Satu paket: dipilih bersama</p>}
                  {lock && <p className="text-xs text-amber-700">{lock}</p>}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button variant="secondary" size="sm" aria-label={`Kurangi ${label}`} disabled={!!lock || qty <= 0}
                    onClick={() => setSel(setLineQty(order.items, sel, lineNo, qty - 1))}>-</Button>
                  <span className="w-8 text-center font-bold" aria-label={`Jumlah ${label}`}>{qty}</span>
                  <Button variant="secondary" size="sm" aria-label={`Tambah ${label}`} disabled={!!lock || qty >= max}
                    onClick={() => setSel(setLineQty(order.items, sel, lineNo, qty + 1))}>+</Button>
                </div>
              </div>
            )
          })}
          <p className="text-xs text-gray-400">Tas hadiah tidak ikut direfund</p>
        </div>
      )}
      <Select label="Alasan Refund *" value={code} onChange={(e) => setCode(e.target.value)}>
        <option value="">Pilih alasan...</option>
        {REASON_PRESETS.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
      </Select>
      {choices && choices.options.length > 0 && (
        <div className="space-y-1.5" role="radiogroup" aria-label="Dikembalikan lewat">
          <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Dikembalikan lewat</p>
          <div className="flex flex-wrap gap-2">
            {choices.options.map((c) => (
              <Button key={c.id} variant={c.id === shown ? 'primary' : 'secondary'} size="sm" role="radio" aria-checked={c.id === shown}
                onClick={() => setPayoutPick(c.id)}>
                {c.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-gray-400">Transaksi ini dibayar dengan beberapa metode. Pilih metode untuk mengembalikan uang; satu refund satu metode.</p>
        </div>
      )}
      {code === 'lainnya' && (
        <Textarea label="Tuliskan alasan *" value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      )}
      {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={reset}>Batal</Button>
        <Button variant="danger" className="flex-1" onClick={askConfirm}>Lanjut</Button>
      </div>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Konfirmasi refund"
        size="sm"
        footer={
          <div className="flex gap-2 w-full">
            <Button variant="secondary" className="flex-1" onClick={() => setConfirming(false)}>Batal</Button>
            <Button variant="danger" className="flex-1" loading={busy} onClick={() => void submit()}>Refund</Button>
          </div>
        }
      >
        <div className="space-y-2 text-sm">
          {legacy ? (
            <p>Seluruh transaksi {order.orderNumber} akan di-refund.</p>
          ) : (
            <ul className="space-y-0.5">
              {picked.map((p) => {
                const it = order.items.find((i) => i.lineNo === p.lineNo)
                return <li key={p.lineNo}>{it?.productName ?? `Baris ${p.lineNo}`}{it && variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''} ×{p.quantity}</li>
              })}
            </ul>
          )}
          <p className="font-bold">Perkiraan jumlah refund {money(estimate)}</p>
          {shown && <p>Dikembalikan lewat {payoutLabel}</p>}
          <p className="text-xs text-gray-500">Server menghitung jumlah pastinya dan membatasinya pada sisa yang bisa direfund.</p>
        </div>
      </Modal>
    </div>
  )
}
