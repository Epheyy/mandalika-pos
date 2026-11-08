import { useState } from 'react'
import { isCashMethod } from '@mandalika/types'
import type { components } from '@mandalika/api'
import { tenderLabel } from '../lib/paymentLabels'
import { quickCashAmounts } from '../lib/quickCash'
import { applyKey } from '../lib/cashKeypad'
import { Chip } from '../components/ui/Chip'
import { PaymentMethodSwitch } from './PaymentMethodSwitch'
import { Button } from '../components/ui/Button'
import { Sheet } from '../components/ui/Sheet'
import { formatRupiah } from './pricing'
import { useCashField } from './cashInput'
import { cashPredicate, isCovered, MAX_REFERENCE_LEN, MAX_TENDER_LINES, remainingDue, splitBlockReason, type TenderLine } from './tenderSplit'

type PaymentMethodConfig = components['schemas']['AppSettings']['paymentMethods'][number]

const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'] as const

export interface SplitTenderSectionProps {
  /** The order total (after points); Sisa is measured against it. */
  due: number
  /** All configured methods (cash identity) and the enabled ones (the chips). */
  allMethods: readonly PaymentMethodConfig[]
  enabledMethods: readonly PaymentMethodConfig[]
  lines: readonly TenderLine[]
  /** The method chip, the raw typed amount and the optional reference of the line being composed. */
  method: string
  amountInput: string
  reference: string
  disabled: boolean
  onMethodChange: (method: string) => void
  onAmountChange: (amount: string) => void
  onReferenceChange: (reference: string) => void
  onAdd: (line: TenderLine) => void
  /** Back to one method; offered only while no line has been entered. */
  onCancel: () => void
  onRemove: (index: number) => void
}

const parseTyped = (raw: string): number | null => {
  if (raw.trim() === '') return null
  const n = parseFloat(raw.replace(/\./g, ''))
  return Number.isFinite(n) ? n : null
}

/** "Split-Payment" (C6, W2 split mode): pick a method, enter its amount, add it; repeat until Sisa is Lunas. */
export function SplitTenderSection(p: SplitTenderSectionProps) {
  const [removeAt, setRemoveAt] = useState<number | null>(null)
  const cashField = useCashField(p.amountInput, p.onAmountChange)
  const isCash = cashPredicate(p.allMethods)
  const labelOf = (id: string) => tenderLabel(id, p.allMethods)
  const composeCash = isCashMethod(p.allMethods, p.method)
  const sisa = remainingDue(p.due, p.lines)
  const covered = isCovered(p.due, p.lines)
  const full = p.lines.length >= MAX_TENDER_LINES && !p.lines.some((l) => isCash(l.method) && composeCash)
  const typed = parseTyped(p.amountInput)
  // A blank entry means "Sisa", never zero: the split POS never sends a zero line.
  const entered = typed ?? sisa
  const canAdd = !covered && !full && !p.disabled && entered >= 1
  const block = p.lines.length > 0 ? splitBlockReason(p.due, p.lines, isCash, labelOf) : null
  const overCharged = block !== null && block.startsWith('Total berubah')

  const add = () => {
    if (!canAdd) return
    const line: TenderLine = { method: p.method, amount: entered, ...(!composeCash && p.reference.trim() ? { reference: p.reference.trim() } : {}) }
    p.onAdd(line)
  }
  const askRemove = (i: number) => {
    // A charged non-cash line may still be live on the EDC/QRIS machine (D-63).
    if (isCash(p.lines[i]!.method)) p.onRemove(i)
    else setRemoveAt(i)
  }

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <p className="text-xs font-semibold text-ink-700 mb-2">Metode Pembayaran</p>
        <PaymentMethodSwitch
          methods={p.enabledMethods.map((m) => ({ id: m.id, label: tenderLabel(m.id, p.allMethods) }))}
          selected={p.method}
          disabled={p.disabled}
          onChange={p.onMethodChange}
        />
      </div>

      {p.lines.length === 0 && (
        <button type="button" onClick={p.onCancel} className="min-h-12 text-sm font-semibold text-brand underline">
          Satu metode saja
        </button>
      )}

      {!covered && (
        <div>
          <label htmlFor="split-amount" className="block text-sm font-semibold text-ink-700 mb-2">
            {composeCash ? 'Diterima (Tunai)' : `Jumlah ${labelOf(p.method)}`}
          </label>
          <div className="flex gap-2">
            <input
              id="split-amount"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              {...cashField}
              placeholder={formatRupiah(sisa)}
              aria-label="Jumlah pembayaran ini"
              className="flex-1 min-w-0 h-14 border-2 border-ink-700 rounded-control px-4 text-[1.75rem] font-bold tnum text-ink-900 focus:outline-none"
            />
            {!composeCash && (
              <Chip tone="info" onClick={() => p.onAmountChange(String(sisa))} className="!min-h-14 !px-4 shrink-0">
                Sisa
              </Chip>
            )}
          </div>
          {typed === null && <p className="text-xs text-ink-500 mt-1">Kosong = sisa tagihan {formatRupiah(sisa)}.</p>}
          {composeCash && (
            <>
              <div className="flex gap-2 flex-wrap mt-2">
                {quickCashAmounts(sisa).map((amt, i) => (
                  <Chip key={amt} selected={typed === amt || (i === 0 && typed === null)} onClick={() => p.onAmountChange(String(amt))}>
                    {i === 0 ? 'Uang pas' : formatRupiah(amt)}
                  </Chip>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3">
                {KEYPAD_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => p.onAmountChange(applyKey(p.amountInput, k))}
                    aria-label={k === '⌫' ? 'Hapus satu angka' : undefined}
                    className="h-12 rounded-control bg-paper-1 text-lg font-semibold tnum text-ink-900 active:bg-paper-2"
                  >
                    {k}
                  </button>
                ))}
              </div>
            </>
          )}
          {!composeCash && (
            <>
              {typed !== null && typed > sisa && <p className="text-xs text-ink-500 mt-1">Maksimal Sisa {formatRupiah(sisa)}.</p>}
              <label htmlFor="split-reference" className="block text-xs font-semibold text-ink-700 mt-3 mb-1">No. referensi (opsional)</label>
              <input
                id="split-reference"
                type="text"
                maxLength={MAX_REFERENCE_LEN}
                value={p.reference}
                onChange={(e) => p.onReferenceChange(e.target.value)}
                className="w-full min-h-11 border border-paper-2 rounded-control px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand bg-white"
              />
            </>
          )}
          <Button variant="secondary" fullWidth className="mt-3" onClick={add} disabled={!canAdd}>
            + Tambah pembayaran
          </Button>
          {full && <p className="text-xs text-ink-500 mt-1">Paling banyak {MAX_TENDER_LINES} pembayaran per transaksi.</p>}
        </div>
      )}

      {p.lines.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-ink-700 mb-2">Pembayaran</p>
          <ul className="divide-y divide-paper-2 rounded-control bg-paper-1">
            {p.lines.map((l, i) => (
              <li key={`${l.method}-${i}`} className="flex items-center gap-2 px-3 py-1">
                <span className="flex-1 text-sm text-ink-900">
                  {labelOf(l.method)}
                  {l.reference ? <span className="text-ink-500"> · Ref {l.reference}</span> : null}
                </span>
                <span className="text-sm font-semibold tnum text-ink-900">{formatRupiah(l.amount)}</span>
                <button
                  type="button"
                  onClick={() => askRemove(i)}
                  disabled={p.disabled}
                  aria-label={`Hapus pembayaran ${labelOf(l.method)}`}
                  className="min-h-12 min-w-12 text-xl leading-none text-ink-500 disabled:opacity-50"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-ink-700">Sisa tagihan</span>
        {covered ? (
          <span className="text-[1.75rem] font-bold tnum text-ok">Lunas</span>
        ) : (
          <span className="text-[1.75rem] font-bold tnum text-warn">{formatRupiah(sisa)}</span>
        )}
      </div>
      {!covered && <p className="text-xs text-ink-500">Konfirmasi aktif setelah sisa tagihan Lunas.</p>}
      {overCharged && block && (
        <p role="alert" className="text-xs font-semibold text-danger bg-danger-bg rounded-control px-3 py-2">{block}</p>
      )}

      {removeAt !== null && p.lines[removeAt] && (
        <Sheet open variant="center" z={60} maxWidth="max-w-sm" panelClassName="p-5" onClose={() => setRemoveAt(null)}>
          <h3 className="text-base font-black text-ink-900 mb-2">Hapus pembayaran {labelOf(p.lines[removeAt]!.method)}?</h3>
          <p className="text-xs text-ink-500 mb-4">Sudah dibatalkan di mesin EDC/QRIS? Pembayaran yang sudah ditagih tidak hilang dengan sendirinya.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setRemoveAt(null)}>Batal</Button>
            <Button
              variant="danger"
              className="flex-1"
              onClick={() => {
                p.onRemove(removeAt)
                setRemoveAt(null)
              }}
            >
              Hapus
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  )
}
