import { use, useEffect, useMemo, useState } from 'react'
import { SyncContext } from '../cashier/SyncProvider'
import { queuedSalesFrom, type QueuedSale } from '../lib/queuedSales'

const REFRESH_MS = 2000
const LAST_SYNCED_KEY = 'mandalika.pos.lastSyncedAt'

export interface KoneksiData {
  /** Sales still waiting in the outbox, oldest first. */
  queued: QueuedSale[]
  /** When reference data (products, promos) was last pulled, epoch ms; null when unknown. */
  dataUpdatedAt: number | null
  /** Epoch ms, refreshed with the sheet (never read from the clock during render). */
  now: number
}


function storedPullTime(): number | null {
  try {
    const t = Date.parse(localStorage.getItem(LAST_SYNCED_KEY) ?? '')
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

/** Read-only data for the Koneksi sheet body (W5-03, W5-08): the queued sales and the data freshness, refreshed
 *  while the sheet is open. Empty without an engine (tests, boot). Never writes to the engine. */
export function useKoneksiData(open: boolean, pendingCount: number): KoneksiData {
  const engine = use(SyncContext)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh the clock when the sheet opens
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), REFRESH_MS)
    return () => clearInterval(id)
  }, [open])
  return useMemo(() => {
    const live = open && engine
    return {
      queued: live ? queuedSalesFrom(engine.localReceipts()) : [],
      dataUpdatedAt: live ? (engine.lastPulledAt() ?? storedPullTime()) : null,
      now,
    }
    // now and pendingCount are refresh triggers, not inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, open, pendingCount, now])
}

/** When the tablet went offline (epoch ms), anchored when `offlineMs` changes so the shown time does not creep
 *  with every render (the cap value only moves about once a minute). Null while online or unknown. */
export function useOfflineStart(offlineMs: number | null): number | null {
  const [start, setStart] = useState<number | null>(null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the clock once per cap change, never during render
    setStart(offlineMs === null ? null : Date.now() - offlineMs)
  }, [offlineMs])
  return start
}
