import { use, useEffect, useState } from 'react'
import { SyncContext } from '../cashier/SyncProvider'
import type { QueueCounts } from '../lib/queueGuard'

export type LiveQueue = QueueCounts & { online: boolean }

/** C2: the engine's live queue counts (re-read every 2 s). Null outside a SyncProvider. Raw engine truth, never filtered by "ditangani". */
export function useQueueCounts(): LiveQueue | null {
  const engine = use(SyncContext)
  const read = (): LiveQueue | null => {
    if (!engine) return null
    const s = engine.queueSummary()
    return { pending: s.pending, parked: s.parkedStamped + s.parkedUnstamped, parkedUnstamped: s.parkedUnstamped, online: engine.isReachable() }
  }
  const [counts, setCounts] = useState(read)
  useEffect(() => {
    if (!engine) return
    const t = setInterval(() => {
      const next = read()
      setCounts((p) => (p && next && p.pending === next.pending && p.parked === next.parked && p.parkedUnstamped === next.parkedUnstamped && p.online === next.online ? p : next))
    }, 2000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])
  return counts
}
