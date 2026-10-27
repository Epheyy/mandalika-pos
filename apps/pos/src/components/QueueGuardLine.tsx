import { queueCountsLine } from '../lib/queueGuard'
import { StatusBadge } from './ui'

/** C2 (P13): live unsynced counts above a guarded button, plus why it is disabled when it is. */
export function QueueGuardLine({ pending, parked, reason }: { pending: number; parked: number; reason?: string | null }) {
  const line = queueCountsLine({ pending, parked })
  return (
    <div className="space-y-1" data-testid="queue-guard">
      <StatusBadge tone={line.tone} label={line.text} dot size="md" />
      {reason && <p role="status" className="text-xs font-semibold text-ink-700">{reason}</p>}
    </div>
  )
}
