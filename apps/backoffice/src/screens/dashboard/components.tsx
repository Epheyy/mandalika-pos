import type { ReactNode } from 'react'
import { Card } from '../../ui/Card'

interface KpiCardProps {
  label: string
  value: string
  sub?: string
  /** Percent change vs the previous period; null hides the delta. */
  deltaPct?: number | null
  /** Comparison words shown in the delta pill, e.g. "vs 30 hari lalu". */
  compare?: string
}

/** Delta text of the KPI pill: one id-ID decimal, arrow; the sign is carried by the arrow (and by `deltaDirection`). */
export function formatDelta(pct: number): string {
  const r = Math.round(pct * 10) / 10
  const n = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(r))
  return `${r >= 0 ? '↗' : '↘'} ${n}%`
}

/** Spoken direction of a delta, from the same rounded value the pill shows. */
export const deltaDirection = (pct: number): 'naik' | 'turun' => (Math.round(pct * 10) / 10 >= 0 ? 'naik' : 'turun')

/** Headline metric (Kaca BO5): grey label on top, big value, delta as a tinted pill with the comparison words. */
export function KpiCard({ label, value, sub, deltaPct, compare }: KpiCardProps) {
  const up = deltaPct != null && deltaDirection(deltaPct) === 'naik'
  return (
    <Card className="p-5">
      <p className="text-[13px] text-ink-500">{label}</p>
      <p className="text-2xl font-black text-ink-900 leading-none my-2 tabular-nums">{value}</p>
      {deltaPct != null && (
        <span
          className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${up ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}
        >
          <span className="sr-only">{deltaDirection(deltaPct)} </span>
          <span aria-hidden="true">{formatDelta(deltaPct)}</span>
          {compare ? ` ${compare}` : ''}
        </span>
      )}
      {sub && <p className="text-xs text-ink-500 mt-1.5">{sub}</p>}
    </Card>
  )
}

interface RankedRow {
  name: string
  right: ReactNode
}

/** Numbered "1. Name … value" list used for top/bottom products and promos. */
export function RankedList({ rows, empty }: { rows: RankedRow[]; empty: string }) {
  if (rows.length === 0)
    return <p className="text-sm text-ink-500 py-10 text-center">{empty}</p>
  return (
    <div className="divide-y divide-gray-50">
      {rows.map((r, i) => (
        <div key={r.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
          <span className="text-ink-700 truncate min-w-0">
            <span className="text-ink-500 tabular-nums mr-1">{i + 1}.</span>
            {r.name}
          </span>
          <span className="font-bold text-gray-900 whitespace-nowrap flex-shrink-0">{r.right}</span>
        </div>
      ))}
    </div>
  )
}
