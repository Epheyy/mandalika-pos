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

  const hasInput = coins > 0 || Object.values(counts).some((n) => n > 0)

  return (
    <Sheet
      open onClose={onClose} variant="side" z={70} title="Hitung lembar" header closeLabel="Batal"
      panelClassName="flex flex-col" testId="denomination-sheet"
    >
      <div className="flex flex-shrink-0 items-center justify-between gap-3 px-5 py-2">
        <p className="text-sm text-ink-500">Alat bantu hitung uang fisik di laci. Ketuk "Pakai" untuk mengisi kolom Terhitung.</p>
        <Button variant="ghost" disabled={!hasInput} onClick={() => { setCounts({}); setCoins(0) }} className="min-h-11 flex-shrink-0 px-3">Reset</Button>
      </div>
      <div className="flex-1 overflow-y-auto px-5">
        {DENOMINATIONS.map((d) => (
          <div key={d} className="flex min-h-16 items-center gap-2 border-b border-paper-2 py-2">
            <span className="tnum w-24 flex-shrink-0 text-[0.9375rem] font-semibold text-ink-900">{formatRupiah(d)}</span>
            <Stepper value={counts[d] ?? 0} min={0} onDecrement={() => setCount(d, (counts[d] ?? 0) - 1)} onIncrement={() => setCount(d, (counts[d] ?? 0) + 1)} />
            <input
              type="number" inputMode="numeric" min={0} aria-label={`Jumlah lembar ${formatRupiah(d)}`}
              value={counts[d] ? String(counts[d]) : ''} placeholder="0" onChange={(e) => setCount(d, clampCount(e.target.value))}
              className="tnum min-h-12 w-16 rounded-control border border-paper-2 bg-paper-0 px-2 text-right text-sm font-bold focus:border-ink-700 focus:outline-none"
            />
            <span className={`tnum min-w-0 flex-1 truncate text-right text-sm ${counts[d] ? 'font-bold text-ink-900' : 'text-ink-500'}`}>{formatRupiah(d * (counts[d] ?? 0))}</span>
          </div>
        ))}
        <div className="flex min-h-16 items-center justify-between gap-2 py-2">
          <label htmlFor="denom-coins" className="text-[0.9375rem] font-semibold text-ink-900">Koin (total Rp)</label>
          <input
            id="denom-coins" type="number" inputMode="numeric" min={0} value={coins ? String(coins) : ''} placeholder="0"
            onChange={(e) => setCoins(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="tnum min-h-12 w-32 rounded-control border border-paper-2 bg-paper-0 px-2 text-right text-sm font-bold focus:border-ink-700 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-paper-2 p-4">
        <div>
          <p className="text-xs font-semibold text-ink-500">Total</p>
          <p className="tnum text-xl font-black text-ink-900">{formatRupiah(total)}</p>
        </div>
        <Button onClick={() => onApply(total)} size="lg" className="min-w-40">Pakai</Button>
      </div>
    </Sheet>
  )
}
