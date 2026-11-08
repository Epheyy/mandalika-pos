import { useEffect, useState, type MutableRefObject } from 'react'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { CashAmountInput } from './CashAmountInput'
import { MAX_NOTE_COUNT, parseNoteCount } from './recapEntry'
import { formatRupiah } from './pricing'
import { DENOMINATIONS, denominationTotal } from './countRules'

interface Props {
  /** Fills Terhitung Tunai with the total; the parent closes the sheet. */
  onApply: (total: number) => void
  onClose: () => void
  /** Android Back closes this sheet before the recap behind it (returns true when it did). */
  backRef?: MutableRefObject<(() => boolean) | null>
}

const STEP_BUTTON = 'touch press inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control bg-paper-1 text-lg font-semibold text-ink-900 active:bg-paper-2 disabled:opacity-40'

/** D-5 denomination counter: notes × count plus coins, live total, "Pakai" writes it into Terhitung Tunai. Display aid only. */
export function DenominationSheet({ onApply, onClose, backRef }: Props) {
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [coins, setCoins] = useState(0)
  const total = denominationTotal(counts, coins)
  const setCount = (d: number, n: number): void => setCounts((prev) => ({ ...prev, [d]: Math.min(MAX_NOTE_COUNT, Math.max(0, n)) }))

  useEffect(() => {
    if (!backRef) return
    backRef.current = () => { onClose(); return true }
    return () => { backRef.current = null }
  }, [backRef, onClose])

  const hasInput = coins > 0 || Object.values(counts).some((n) => n > 0)

  return (
    <Sheet
      open onClose={onClose} variant="side" z={70} title="Hitung Lembar Tunai" header
      panelClassName="flex flex-col" testId="denomination-sheet"
    >
      <div className="flex flex-shrink-0 items-start justify-between gap-3 px-5 py-2">
        <p className="text-sm text-ink-500">Alat bantu hitung uang fisik di laci. Ketuk "Pakai Hasil Hitung" untuk mengisi kolom Terhitung Tunai.</p>
        <Button variant="ghost" disabled={!hasInput} onClick={() => { setCounts({}); setCoins(0) }} className="min-h-11 flex-shrink-0 px-3">Reset</Button>
      </div>
      <div className="flex-1 overflow-y-auto px-5">
        {DENOMINATIONS.map((d) => (
          <div key={d} className="flex min-h-16 items-center gap-2 border-b border-paper-2 py-2">
            <span className="tnum w-24 flex-shrink-0 text-[0.9375rem] font-semibold text-ink-900">{formatRupiah(d)}</span>
            <div className="inline-flex flex-shrink-0 items-center gap-2">
              <button type="button" aria-label="Kurangi" className={STEP_BUTTON} disabled={(counts[d] ?? 0) <= 0} onClick={() => setCount(d, (counts[d] ?? 0) - 1)}>−</button>
              <input
                type="text" inputMode="numeric" autoComplete="off" aria-label={`Jumlah lembar ${formatRupiah(d)}`}
                value={counts[d] ? String(counts[d]) : ''} placeholder="0" onChange={(e) => setCount(d, parseNoteCount(e.target.value))}
                className="tnum min-h-11 w-16 rounded-control border border-paper-2 bg-paper-0 px-2 text-center text-sm font-bold focus:border-ink-700 focus:outline-none"
              />
              <button type="button" aria-label="Tambah" className={STEP_BUTTON} disabled={(counts[d] ?? 0) >= MAX_NOTE_COUNT} onClick={() => setCount(d, (counts[d] ?? 0) + 1)}>+</button>
            </div>
            <span className={`tnum min-w-0 flex-1 whitespace-nowrap text-right text-sm ${counts[d] ? 'font-bold text-ink-900' : 'text-ink-500'}`}>{formatRupiah(d * (counts[d] ?? 0))}</span>
          </div>
        ))}
        <div className="flex min-h-16 items-center justify-between gap-2 py-2">
          <label htmlFor="denom-coins" className="text-[0.9375rem] font-semibold text-ink-900">Koin (total Rp)</label>
          <CashAmountInput
            id="denom-coins" raw={coins ? String(coins) : ''} placeholder="Rp 0"
            onRawChange={(raw) => setCoins(Number(raw) || 0)}
            className="tnum min-h-12 w-40 rounded-control border border-paper-2 bg-paper-0 px-2 text-right text-sm font-bold focus:border-ink-700 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex-shrink-0 border-t border-paper-2 p-4">
        <button
          type="button" onClick={() => onApply(total)}
          className="bar-primary press-bar tnum flex min-h-16 w-full items-center justify-between px-5 text-base font-bold"
        >
          <span>Pakai Hasil Hitung</span>
          <span className="text-xl font-black">{formatRupiah(total)}</span>
        </button>
      </div>
    </Sheet>
  )
}
