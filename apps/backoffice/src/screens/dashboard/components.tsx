import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Card } from '../../ui/Card'

interface KpiCardProps {
  label: string
  value: string
  sub?: string
  icon: ReactNode
  /** Percent change vs the previous period; null hides the delta. */
  deltaPct?: number | null
}

/** Headline metric with a gold icon chip and an optional period-over-period delta. */
export function KpiCard({ label, value, sub, icon, deltaPct }: KpiCardProps) {
  const up = deltaPct != null && deltaPct >= 0
  return (
    <Card className="p-5 hover:shadow-md transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gold-50 text-gold-600">
          {icon}
        </div>
        {deltaPct != null && (
          <span
            className={`inline-flex items-center gap-0.5 text-xs font-bold ${up ? 'text-green-600' : 'text-red-600'}`}
            title="vs periode sebelumnya"
          >
            {up ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
            {Math.abs(deltaPct).toFixed(0)}%
          </span>
        )}
      </div>
      <p className="text-2xl font-black text-gray-900 leading-none mb-1">{value}</p>
      <p className="text-xs font-bold text-gray-400">{label}</p>
      {sub && <p className="text-xs text-gray-300 mt-0.5">{sub}</p>}
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
    return <p className="text-sm text-gray-400 py-10 text-center">{empty}</p>
  return (
    <div className="divide-y divide-gray-50">
      {rows.map((r, i) => (
        <div key={r.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
          <span className="text-gray-600 truncate min-w-0">
            <span className="text-gray-400 tabular-nums mr-1">{i + 1}.</span>
            {r.name}
          </span>
          <span className="font-bold text-gray-900 whitespace-nowrap flex-shrink-0">{r.right}</span>
        </div>
      ))}
    </div>
  )
}
