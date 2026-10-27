import { useCallback, useEffect, useState } from 'react'
import type { SyncEngine } from '@mandalika/sync'
import type { FailedItem } from './useOfflineData'
import { acknowledge, announceParked, dismissParkedAlert, nextParkedAlert, readAcknowledged, releaseParked, unacknowledge, useParkedAlertState } from '../lib/parkedSale'

/** C2: the parked-sale banner (one per key, only while the cart is empty), the locally acknowledged rows, and
 *  the re-queue hook that makes a sale that parks AGAIN visible again. */
export function useParkedBanner(engine: SyncEngine, review: FailedItem[], cartEmpty: boolean) {
  const [acked, setAcked] = useState(readAcknowledged)
  const alerts = useParkedAlertState()
  // The engine announces each key once per run; a sale re-queued and parked again is announced here instead.
  useEffect(() => {
    announceParked(review.filter((r) => r.type === 'order' && !acked.has(r.idempotencyKey)).map((r) => r.idempotencyKey))
  }, [review, acked])
  const key = nextParkedAlert({
    announced: alerts.announced,
    dismissed: alerts.dismissed,
    acknowledged: acked,
    parkedKeys: new Set(review.map((r) => r.idempotencyKey)),
    cartEmpty,
  })
  const ref = key ? engine.localReceipts().find((r) => r.idempotencyKey === key)?.orderNumber ?? null : null
  const onAcknowledge = useCallback((k: string) => setAcked((prev) => acknowledge(k, prev)), [])
  /** Call after items were re-queued: they stop being "handled" and may alert again if they park again. */
  const onRequeued = useCallback((keys: readonly string[]) => {
    releaseParked(keys)
    setAcked((prev) => unacknowledge(keys, prev))
  }, [])
  return {
    acked,
    onAcknowledge,
    onRequeued,
    banner: key ? { key, ref: ref ?? 'penjualan' } : null,
    dismissBanner: dismissParkedAlert,
  }
}
