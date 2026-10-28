import { memo, useMemo, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { MAX_REFUND_REASON_CHARS } from '@mandalika/types'
import { PAYMENT_LABELS, refundPartialNote } from './refundView'
import {
  EMPTY_SELECTION, GIVEAWAY_NOTE, REASON_PRESETS, WHOLE_ONLY_NOTE, buildReason, buildRefundBasis, lineLockReason, pickedUnits,
  refundAmountFor, remainingAmount, selectAll, setLineQty, toggleLine,
  type RefundBasis, type RefundCache, type RefundLine, type Selection,
} from './refundSelection'
import { Sheet } from '../components/ui/Sheet'

type Order = components['schemas']['Order']

/** What the cashier confirmed. The payload's items and amount are re-derived from this, never copied from the screen. */
export interface RefundConfirmInput {
  reason: string
  reasonCode: string
  selection: Selection
}

interface RefundDialogProps {
  order: Order | null
  /** Units and money this tablet saw acknowledged for earlier refunds of the order (a cache; the order row wins when larger). */
  cache?: RefundCache
  isProcessing: boolean
  /** Persistent error when the refund could not be stored on the device. */
  error?: string | null
  onConfirm: (orderId: string, input: RefundConfirmInput) => void
  onClose: () => void
}

const CHIP = 'min-h-11 px-3 rounded-xl border text-sm font-semibold transition-colors'

function LineRow({ line, lines, sel, onChange, onToggle }: {
  line: RefundLine
  lines: readonly RefundLine[]
  sel: Selection
  onChange: (lineNo: number, qty: number) => void
  onToggle: (lineNo: number) => void
}) {
  const locked = lineLockReason(line, lines)
  const picked = sel[line.lineNo] ?? 0
  const grouped = line.group !== null
  const discounted = line.soldQty > 0 && line.net < line.unitPrice * line.soldQty
  return (
    <div className={`flex items-center gap-3 min-h-14 px-3 py-2 ${locked ? 'opacity-50' : ''}`} data-testid="refund-line">
      <button type="button" role="checkbox" aria-checked={picked > 0} aria-label={`Pilih ${line.name}`} disabled={locked !== null}
        onClick={() => onToggle(line.lineNo)}
        className={`w-8 h-8 shrink-0 rounded-lg border-2 flex items-center justify-center text-white text-lg ${picked > 0 ? 'bg-danger-solid border-danger-solid' : 'border-gray-300 bg-white'}`}>
        {picked > 0 ? '✓' : ''}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900 truncate">{line.name}{line.isReward && line.net === 0 ? ' · GRATIS' : ''}</p>
        <p className="text-[11px] text-gray-500">
          {locked ?? `${line.remainingQty} dari ${line.soldQty} bisa direfund`}
          {line.refundedQty > 0 && !locked ? ` · ${line.refundedQty} sudah direfund` : ''}
        </p>
      </div>
      {!grouped && !locked && line.remainingQty > 1 && (
        <div className="flex items-center gap-1" role="group" aria-label={`Jumlah ${line.name}`}>
          <button type="button" aria-label={`Kurangi ${line.name}`} onClick={() => onChange(line.lineNo, picked - 1)} disabled={picked === 0}
            className="w-11 h-11 rounded-xl border border-gray-200 text-lg font-bold disabled:opacity-30">−</button>
          <span className="w-12 text-center text-sm font-semibold tabular-nums" aria-live="polite">{picked} / {line.remainingQty}</span>
          <button type="button" aria-label={`Tambah ${line.name}`} onClick={() => onChange(line.lineNo, picked + 1)} disabled={picked >= line.remainingQty}
            className="w-11 h-11 rounded-xl border border-gray-200 text-lg font-bold disabled:opacity-30">+</button>
        </div>
      )}
      <div className="text-right shrink-0 w-24">
        {discounted && <p className="text-[10px] text-gray-400 line-through">{formatRupiah(line.unitPrice * line.soldQty)}</p>}
        <p className="text-sm font-semibold text-gray-900">{formatRupiah(line.net)}</p>
      </div>
    </div>
  )
}

function LinesList({ basis, sel, setSel }: { basis: Extract<RefundBasis, { kind: 'lines' }>; sel: Selection; setSel: (s: Selection) => void }) {
  const { lines } = basis
  const change = (lineNo: number, qty: number) => setSel(setLineQty(lines, sel, lineNo, qty))
  const toggle = (lineNo: number) => setSel(toggleLine(lines, sel, lineNo))
  const groups = [...new Set(lines.flatMap((l) => (l.group ? [l.group] : [])))]
  const loose = lines.filter((l) => !l.group)
  return (
    <div className="space-y-2 mb-3">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setSel(selectAll(lines))} className="min-h-11 px-3 rounded-xl border border-gray-200 text-sm font-semibold text-gray-700">Pilih semua</button>
        {pickedUnits(sel) > 0 && <button type="button" onClick={() => setSel(EMPTY_SELECTION)} className="min-h-11 px-3 text-sm font-semibold text-gray-500">Kosongkan</button>}
      </div>
      <div className="rounded-xl border border-gray-100 divide-y divide-gray-100">
        {loose.map((l) => <LineRow key={l.lineNo} line={l} lines={lines} sel={sel} onChange={change} onToggle={toggle} />)}
      </div>
      {groups.map((g) => (
        <div key={g} className="rounded-xl border border-indigo-100 bg-indigo-50/40" data-testid="refund-group">
          <p className="px-3 pt-2 text-[11px] font-semibold text-indigo-700">Paket (refund bersama)</p>
          <div className="divide-y divide-indigo-100">
            {lines.filter((l) => l.group === g).map((l) => <LineRow key={l.lineNo} line={l} lines={lines} sel={sel} onChange={change} onToggle={toggle} />)}
          </div>
        </div>
      ))}
      {basis.giveaway && <p className="text-[11px] text-gray-500">{basis.giveaway}: {GIVEAWAY_NOTE}</p>}
    </div>
  )
}

/** Opens for an order. The body is keyed by the order, so a different order starts with no pick, reason or text
 *  carried over from the previous refund (no state-reset effect needed). */
export const RefundDialog = memo(function RefundDialog(props: RefundDialogProps) {
  return props.order ? <RefundDialogBody key={props.order.id} {...props} order={props.order} /> : null
})

function RefundDialogBody({ order, cache, isProcessing, error, onConfirm, onClose }: RefundDialogProps & { order: Order }) {
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const [code, setCode] = useState<string | null>(null)
  const [text, setText] = useState('')

  const basis = useMemo(() => buildRefundBasis(order, cache), [order, cache])

  const reason = buildReason(code, text)
  const perLine = basis.kind === 'lines'
  const result = perLine ? refundAmountFor(basis, sel) : null
  const amount = result ? result.amount : basis.total
  const hasPick = perLine ? pickedUnits(sel) > 0 : true
  const ready = hasPick && reason.ok && !isProcessing
  const method = PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod

  const confirm = () => {
    if (!ready || !reason.ok) return
    onConfirm(order.id, { reason: reason.reason, reasonCode: reason.reasonCode, selection: sel })
  }

  return (
    <Sheet open variant="center" maxWidth="max-w-lg" panelClassName="p-5 max-h-[92vh] overflow-y-auto">
      <h3 className="font-bold text-gray-900 mb-1">Refund Order</h3>
      <p className="text-xs text-gray-500 mb-1">{order.orderNumber} · Dibayar {method} {formatRupiah(order.total)}</p>
      {perLine && basis.priorAmount > 0 && (
        <p className="inline-block text-[11px] font-semibold text-amber-800 bg-amber-100 rounded-full px-2 py-0.5 mb-3">{refundPartialNote(remainingAmount(basis))}</p>
      )}

      {perLine ? (
        <LinesList basis={basis} sel={sel} setSel={setSel} />
      ) : (
        <div className="bg-gray-50 rounded-xl p-3 mb-3 space-y-1">
          <p className="text-[11px] font-semibold text-amber-800 mb-1">{WHOLE_ONLY_NOTE}</p>
          {basis.items.map((item, i) => (
            <div key={`${item.name}-${i}`} className="flex justify-between text-xs text-gray-700">
              <span>{item.name} ×{item.quantity}</span>
              <span>{formatRupiah(item.subtotal)}</span>
            </div>
          ))}
          {basis.giveaway && <p className="text-[11px] text-gray-500 pt-1">{basis.giveaway}: {GIVEAWAY_NOTE}</p>}
        </div>
      )}

      <p id="refund-reason-label" className="block text-xs text-gray-700 font-semibold mb-1">Alasan Refund *</p>
      <div role="group" aria-labelledby="refund-reason-label" className="flex flex-wrap gap-2 mb-2">
        {REASON_PRESETS.map((p) => (
          <button key={p.code} type="button" aria-pressed={code === p.code} onClick={() => setCode(p.code)}
            className={`${CHIP} ${code === p.code ? 'bg-ink-900 text-white border-ink-900' : 'bg-white text-gray-700 border-gray-200'}`}>
            {p.label}
          </button>
        ))}
      </div>
      {code === 'lainnya' && (
        <>
          <label htmlFor="refund-reason" className="block text-[11px] text-gray-600 mb-1">Tulis alasan</label>
          <textarea id="refund-reason" value={text} onChange={(e) => setText(e.target.value)} placeholder="Masukkan alasan refund…" rows={2}
            maxLength={MAX_REFUND_REASON_CHARS}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 mb-1 resize-none" />
          <p className="text-[10px] text-gray-400 text-right mb-2">{`${[...text].length}/${MAX_REFUND_REASON_CHARS}`}</p>
        </>
      )}

      <div className="flex items-baseline justify-between border-t border-gray-100 pt-3 mt-2 mb-1">
        <span className="text-sm text-gray-700">Dikembalikan ke pelanggan</span>
        <span className="text-lg font-bold text-gray-900" data-testid="refund-amount">{formatRupiah(amount)}</span>
      </div>
      <p className="text-[10px] text-gray-400 mb-4">
        {result?.settlesRemainder ? 'Refund terakhir: jumlah sisa transaksi. ' : ''}
        Dibayar lewat {method}. Stok akan dipulihkan oleh kantor pusat saat terkirim.
      </p>

      {error && (
        <p role="alert" className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={confirm} disabled={!ready}
          className="flex-1 min-h-12 bg-danger-solid text-white rounded-xl font-semibold text-sm disabled:opacity-40 active:opacity-90 transition-colors">
          {isProcessing ? 'Memproses…' : `Konfirmasi Refund ${formatRupiah(amount)}`}
        </button>
        <button type="button" onClick={onClose} disabled={isProcessing}
          className="flex-1 min-h-12 border border-gray-200 rounded-xl font-semibold text-sm text-gray-700 hover:bg-gray-50">
          Batal
        </button>
      </div>
    </Sheet>
  )
}
