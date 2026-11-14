import { formatRupiah } from '../pricing'
import type { VoidRecapRow } from './voidRecap'

const STATE_NOTE: Record<VoidRecapRow['state'], string> = { synced: '', queued: 'belum tersinkron', review: 'perlu ditinjau' }

/** "Pembatalan" section of the shift recap: voids of this shift (synced and still queued). Display only. */
export function VoidRecapList({ rows }: { rows: readonly VoidRecapRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-1 text-xs text-ink-500" data-testid="void-recap-list">
      <div className="font-black text-ink-700">Pembatalan ({rows.length})</div>
      {rows.map((r, i) => (
        <div key={`${r.orderNumber}:${i}`} className="flex justify-between gap-2">
          <span className="min-w-0">
            #{r.orderNumber}{r.reasonLabel ? ` · ${r.reasonLabel}` : ''}{r.voidedBy ? ` · ${r.voidedBy}` : ''}
            {' · '}{r.replacementNumber ? `${r.followup} #${r.replacementNumber}` : r.followup}
            {STATE_NOTE[r.state] ? ` (${STATE_NOTE[r.state]})` : ''}
          </span>
          <span className="tnum shrink-0">{formatRupiah(r.total)}</span>
        </div>
      ))}
    </div>
  )
}
