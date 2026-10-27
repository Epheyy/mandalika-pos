import { useEffect, useState, type MutableRefObject } from 'react'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { Stepper } from '../components/ui/Stepper'
import { formatRupiah } from './pricing'
import { DENOMINATIONS, denominationTotal } from './countRules'

interface Props {
  /** Fills Terhitung Tunai with the total; the parent closes the sheet. */
  onApply: (total: number) => void
  onClose: () => void
  /** Android Back closes this sheet before the recap behind it (returns true when it did). */
  backRef?: MutableRefObject<(() => boolean) | null>
}

const MAX_COUNT = 9999

const clampCount = (raw: string): number => Math.min(MAX_COUNT, Math.max(0, Math.floor(Number(raw) || 0)))

/** D-5 denomination counter: notes × count plus coins, live total, "Pakai" writes it into Terhitung Tunai. Display aid only. */
export function DenominationSheet({ onApply, onClose, backRef }: Props) {
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [coins, setCoins] = useState(0)
  const total = denominationTotal(counts, coins)
  const setCount = (d: number, n: number): void => setCounts((prev) => ({ ...prev, [d]: Math.min(MAX_COUNT, Math.max(0, n)) }))

  useEffect(() => {
    if (!backRef) return
    backRef.current = () => { onClose(); return true }
    return () => { backRef.current = null }
  }, [backRef, onClose])

  return (
    <Sheet open onClose={onClose} variant="side" z={70} title={null} panelClassName="flex flex-col" testId="denomination-sheet">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-paper-2 py-2 pl-4 pr-2">
        <h2 className="text-base font-bold text-ink-900">Hitung lembar</h2>
        <Button variant="ghost" onClick={onClose} className="min-h-11 px-3">Batal</Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4">
        {DENOMINATIONS.map((d) => (
          <div key={d} className="flex min-h-16 items-center justify-between gap-2 border-b border-paper-2 py-2">
            <span className="tnum w-24 text-[0.9375rem] font-semibold text-ink-900">{formatRupiah(d)}</span>
            <Stepper value={counts[d] ?? 0} min={0} onDecrement={() => setCount(d, (counts[d] ?? 0) - 1)} onIncrement={() => setCount(d, (counts[d] ?? 0) + 1)} />
            <input
              type="number" inputMode="numeric" min={0} aria-label={`Jumlah lembar ${formatRupiah(d)}`}
              value={counts[d] ? String(counts[d]) : ''} placeholder="0" onChange={(e) => setCount(d, clampCount(e.target.value))}
              className="tnum min-h-12 w-20 rounded-control border border-paper-2 bg-paper-1 px-2 text-right text-sm font-bold focus:border-ink-700 focus:outline-none"
            />
          </div>
        ))}
        <div className="flex min-h-16 items-center justify-between gap-2 py-2">
          <label htmlFor="denom-coins" className="text-[0.9375rem] font-semibold text-ink-900">Koin (total Rp)</label>
          <input
            id="denom-coins" type="number" inputMode="numeric" min={0} value={coins ? String(coins) : ''} placeholder="0"
            onChange={(e) => setCoins(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="tnum min-h-12 w-32 rounded-control border border-paper-2 bg-paper-1 px-2 text-right text-sm font-bold focus:border-ink-700 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-paper-2 p-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-ink-500">Total</p>
          <p className="tnum text-lg font-black text-ink-900">{formatRupiah(total)}</p>
        </div>
        <Button onClick={() => onApply(total)} className="min-w-32">Pakai</Button>
      </div>
    </Sheet>
  )
}
