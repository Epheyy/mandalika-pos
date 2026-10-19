import { useEffect, useState } from 'react'
import type { OfflineCapState, SyncEngine } from '@mandalika/sync'

const POLL_MS = 30_000

/** The tablet's standing against the 12 h offline cap (A05), refreshed every 30 s so the chip
 *  and the warning stay current. Gates must call engine.offlineState() at action time instead. */
export function useOfflineCap(engine: Pick<SyncEngine, 'offlineState'> | null | undefined): OfflineCapState {
  const [cap, setCap] = useState<OfflineCapState>(() => engine?.offlineState() ?? { level: 'unknown', offlineMs: null })
  useEffect(() => {
    if (!engine) return
    const tick = () => setCap((prev) => {
      const next = engine.offlineState()
      return prev.level === next.level && Math.floor((prev.offlineMs ?? 0) / 60_000) === Math.floor((next.offlineMs ?? 0) / 60_000) ? prev : next
    })
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => clearInterval(id)
  }, [engine])
  return cap
}
