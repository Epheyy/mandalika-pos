import { use, useEffect, useState } from 'react'
import { SyncContext } from '../cashier/SyncProvider'

/** F19: how long the engine must keep reporting "stock drift not pulled yet" before the UI says so. The stock
 *  pull is throttled on purpose (5 min floor, deferred behind open cashier flows); a short lag is normal and
 *  must stay quiet, a long one must not hide behind "Online · Tersinkron". */
export const STOCK_PENDING_SHOW_MS = 60_000
const POLL_MS = 2000

/** First moment the drift was seen continuously, or null once it is gone. */
export function stockPendingSince(prev: number | null, pending: boolean, now: number): number | null {
  return pending ? (prev ?? now) : null
}

export function stockPendingVisible(since: number | null, now: number): boolean {
  return since !== null && now - since >= STOCK_PENDING_SHOW_MS
}

/** True while this tablet's stock snapshot is known to be behind the server for longer than the hold-off.
 *  Read-only (engine.stockRefreshPending); false without an engine or on an engine without the method. */
export function useStockPending(): boolean {
  const engine = use(SyncContext)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!engine || typeof engine.stockRefreshPending !== 'function') return
    let since: number | null = null
    const id = setInterval(() => {
      const now = Date.now()
      since = stockPendingSince(since, engine.stockRefreshPending(), now)
      setVisible(stockPendingVisible(since, now)) // a primitive: React bails out when unchanged
    }, POLL_MS)
    return () => { clearInterval(id); setVisible(false) }
  }, [engine])
  return visible
}
