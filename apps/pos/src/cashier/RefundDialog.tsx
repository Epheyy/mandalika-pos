import { memo, useMemo, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { MAX_REFUND_REASON_CHARS } from '@mandalika/types'
import { PAYMENT_LABELS, defaultPayoutMethod, isSplitOrder, paidByText, payoutChoices, refundPartialNote, tenderName, type PayoutMethodCfg } from './refundView'
import {
  EMPTY_SELECTION, GIVEAWAY_NOTE, REASON_PRESETS, WHOLE_ONLY_NOTE, buildReason, buildRefundBasis, lineLockReason, pickedUnits,
  refundAmountFor, remainingAmount, selectAll, setLineQty, toggleLine,
  type RefundBasis, type RefundCache, type RefundLine, type Selection,
} from './refundSelection'
import { Sheet } from '../components/ui/Sheet'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { StatusBadge } from '../components/ui/StatusBadge'
import { IconCheck } from '../components/ui/icons'

type Order = components['schemas']['Order']

/** What the cashier confirmed. The payload's items and amount are re-derived from this, never copied from the screen. */
export interface RefundConfirmInput {
  reason: string
  reasonCode: string
  selection: Selection
  /** C6 (D-56): the payout chip, set for a split order only. */
  payoutMethod?: string
}

interface RefundDialogProps {
  order: Order | null
  /** Units and money this tablet saw acknowledged for earlier refunds of the order (a cache; the order row wins when larger). */
  cache?: RefundCache
  /** The configured payment methods: names the chips and tells which line is cash. Optional; ids are shown when absent. */
  methods?: readonly PayoutMethodCfg[]
  isProcessing: boolean
  /** Persistent error when the refund could not be stored on the device. */
  error?: string | null
  onConfirm: (orderId: string, input: RefundConfirmInput) => void
  onClose: () => void
}

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
        className={`w-8 h-8 shrink-0 rounded-tag border-2 flex items-center justify-center text-on-brand press ${picked > 0 ? 'bg-brand-strong border-brand-strong' : 'border-ink-500 bg-white'}`}>
        {picked > 0 ? <IconCheck size={18} /> : null}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink-900 truncate">{line.name}{line.isReward && line.net === 0 ? ' · GRATIS' : ''}</p>
        <p className="text-xs text-ink-500">
          {locked ?? `${line.remainingQty} dari ${line.soldQty} bisa direfund`}
          {line.refundedQty > 0 && !locked ? ` · ${line.refundedQty} sudah direfund` : ''}
        </p>
      </div>
      {!grouped && !locked && line.remainingQty > 1 && (
        <div className="flex items-center gap-1" role="group" aria-label={`Jumlah ${line.name}`}>
          <button type="button" aria-label={`Kurangi ${line.name}`} onClick={() => onChange(line.lineNo, picked - 1)} disabled={picked === 0}
            className="w-11 h-11 rounded-control surface-card text-lg font-bold text-ink-900 press disabled:opacity-30">−</button>
          <span className="w-12 text-center text-sm font-semibold tabular-nums" aria-live="polite">{picked} / {line.remainingQty}</span>
          <button type="button" aria-label={`Tambah ${line.name}`} onClick={() => onChange(line.lineNo, picked + 1)} disabled={picked >= line.remainingQty}
            className="w-11 h-11 rounded-control surface-card text-lg font-bold text-ink-900 press disabled:opacity-30">+</button>
        </div>
      )}
      <div className="text-right shrink-0 w-24">
        {discounted && <p className="text-xs text-ink-500 line-through">{formatRupiah(line.unitPrice * line.soldQty)}</p>}
        <p className="text-sm font-semibold text-ink-900">{formatRupiah(line.net)}</p>
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
        <Button variant="secondary" onClick={() => setSel(selectAll(lines))}>Pilih semua</Button>
        {pickedUnits(sel) > 0 && <Button variant="ghost" onClick={() => setSel(EMPTY_SELECTION)}>Kosongkan</Button>}
      </div>
      <div className="rounded-control surface-group divide-y divide-paper-2">
        {loose.map((l) => <LineRow key={l.lineNo} line={l} lines={lines} sel={sel} onChange={change} onToggle={toggle} />)}
      </div>
      {groups.map((g) => (
        <div key={g} className="rounded-control surface-group" data-testid="refund-group">
          <p className="px-3 pt-2 text-xs font-semibold text-promo">Paket (refund bersama)</p>
          <div className="divide-y divide-paper-2">
            {lines.filter((l) => l.group === g).map((l) => <LineRow key={l.lineNo} line={l} lines={lines} sel={sel} onChange={change} onToggle={toggle} />)}
          </div>
        </div>
      ))}
      {basis.giveaway && <p className="text-xs text-ink-500">{basis.giveaway}: {GIVEAWAY_NOTE}</p>}
    </div>
  )
}

/** Opens for an order. The body is keyed by the order, so a different order starts with no pick, reason or text
 *  carried over from the previous refund (no state-reset effect needed). The success toast is raised by the caller
 *  once the refund is stored (CashierScreen), so every close path stays honest. */
export const RefundDialog = memo(function RefundDialog(props: RefundDialogProps) {
  return props.order ? <RefundDialogBody key={props.order.id} {...props} order={props.order} /> : null
})

function RefundDialogBody({ order, cache, methods, isProcessing, error, onConfirm, onClose }: RefundDialogProps & { order: Order }) {
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const [code, setCode] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [payoutPick, setPayoutPick] = useState<string | null>(null)

  const basis = useMemo(() => buildRefundBasis(order, cache), [order, cache])

  const reason = buildReason(code, text)
  const perLine = basis.kind === 'lines'
  const result = perLine ? refundAmountFor(basis, sel) : null
  const amount = result ? result.amount : basis.total
  const hasPick = perLine ? pickedUnits(sel) > 0 : true
  const ready = hasPick && reason.ok && !isProcessing
  const split = isSplitOrder(order)
  const choices = useMemo(() => payoutChoices(order, methods), [order, methods])
  const payout = split ? (payoutPick ?? defaultPayoutMethod(order, methods) ?? undefined) : undefined
  const method = PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod
  const paidBy = split && (order.tenders?.length ?? 0) > 0 ? paidByText(order, methods) : `${method} ${formatRupiah(order.total)}`

  const confirm = () => {
    if (!ready || !reason.ok) return
    onConfirm(order.id, { reason: reason.reason, reasonCode: reason.reasonCode, selection: sel, ...(payout ? { payoutMethod: payout } : {}) })
  }

  return (
    <Sheet open variant="center" maxWidth="max-w-lg" panelClassName="p-5 max-h-[92vh] overflow-y-auto">
      <h3 className="font-bold text-ink-900 mb-1">Refund Order</h3>
      <p className="text-xs text-ink-500 mb-1">{order.orderNumber} · Dibayar {paidBy}</p>
      {perLine && basis.priorAmount > 0 && (
        <StatusBadge tone="warn" label={refundPartialNote(remainingAmount(basis))} className="mb-3" />
      )}

      {perLine ? (
        <LinesList basis={basis} sel={sel} setSel={setSel} />
      ) : (
        <div className="surface-group rounded-control p-3 mb-3 space-y-1">
          <p className="text-xs font-semibold text-warn-strong mb-1">{WHOLE_ONLY_NOTE}</p>
          {basis.items.map((item, i) => (
            <div key={`${item.name}-${i}`} className="flex justify-between text-xs text-ink-700">
              <span>{item.name} ×{item.quantity}</span>
              <span>{formatRupiah(item.subtotal)}</span>
            </div>
          ))}
          {basis.giveaway && <p className="text-xs text-ink-500 pt-1">{basis.giveaway}: {GIVEAWAY_NOTE}</p>}
        </div>
      )}

      <p id="refund-reason-label" className="block text-xs text-ink-700 font-semibold mb-1">Alasan Refund *</p>
      <div role="group" aria-labelledby="refund-reason-label" className="flex flex-wrap gap-2 mb-2">
        {REASON_PRESETS.map((p) => (
          <Chip key={p.code} selected={code === p.code} onClick={() => setCode(p.code)}>{p.label}</Chip>
        ))}
      </div>
      {code === 'lainnya' && (
        <>
          <label htmlFor="refund-reason" className="block text-xs text-ink-700 mb-1">Tulis alasan</label>
          <textarea id="refund-reason" value={text} onChange={(e) => setText(e.target.value)} placeholder="Masukkan alasan refund…" rows={2}
            maxLength={MAX_REFUND_REASON_CHARS}
            className="w-full surface-card rounded-control px-3 py-2 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong mb-1 resize-none" />
          <p className="text-xs text-ink-500 text-right mb-2">{`${[...text].length}/${MAX_REFUND_REASON_CHARS}`}</p>
        </>
      )}

      {split && choices.length > 0 && (
        <>
          <p id="refund-payout-label" className="block text-xs text-ink-700 font-semibold mb-1 mt-2">Dikembalikan lewat</p>
          <div role="group" aria-labelledby="refund-payout-label" className="flex flex-wrap gap-2 mb-2">
            {choices.map((c) => (
              <Chip key={c.id} selected={payout === c.id} onClick={() => setPayoutPick(c.id)}>{c.label}</Chip>
            ))}
          </div>
        </>
      )}

      <div className="flex items-baseline justify-between border-t border-paper-2 pt-3 mt-2 mb-1">
        <span className="text-sm text-ink-700">Dikembalikan ke pelanggan</span>
        <span className="text-lg font-bold text-ink-900" data-testid="refund-amount">{formatRupiah(amount)}</span>
      </div>
      <p className="text-xs text-ink-500 mb-4">
        {result?.settlesRemainder ? 'Refund terakhir: jumlah sisa transaksi. ' : ''}
        {split ? `Dikembalikan lewat ${payout ? tenderName(payout, methods) : 'metode pembayaran'}.` : `Dibayar lewat ${method}.`} Stok akan dipulihkan oleh kantor pusat saat terkirim.
      </p>

      {error && <Banner tone="danger" message={error} className="rounded-control mb-4" />}

      <div className="flex items-stretch gap-2">
        <Button variant="secondary" size="lg" onClick={onClose} disabled={isProcessing} className="shrink-0">
          Batal
        </Button>
        <button type="button" onClick={confirm} disabled={!ready}
          aria-label={isProcessing ? undefined : `Konfirmasi Refund ${formatRupiah(amount)}`}
          className="bar-danger press-bar flex-1 min-h-16 rounded-control px-5 flex items-center justify-between gap-3 font-bold tnum disabled:opacity-40 disabled:pointer-events-none">
          {isProcessing ? <span className="text-base">Memproses…</span> : (
            <>
              <span className="text-lg">Refund</span>
              <span className="text-xl">{formatRupiah(amount)}</span>
            </>
          )}
        </button>
      </div>
    </Sheet>
  )
}
