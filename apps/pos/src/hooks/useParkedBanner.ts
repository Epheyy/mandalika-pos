import { useCallback, useMemo, useState } from 'react'
import type { SyncEngine } from '@mandalika/sync'
import type { FailedItem } from './useOfflineData'
import { acknowledge, dismissParkedAlert, nextParkedAlert, readAcknowledged, useParkedAlertState, visibleReview } from '../lib/parkedSale'

/** C2: the parked-sale banner (one per key, only while the cart is empty) and the locally acknowledged rows. */
export function useParkedBanner(engine: SyncEngine, review: FailedItem[], cartEmpty: boolean) {
  const [acked, setAcked] = useState(readAcknowledged)
  const alerts = useParkedAlertState()
  const shown = useMemo(() => visibleReview(review, acked), [review, acked])
  const key = nextParkedAlert({
    announced: alerts.announced,
    dismissed: alerts.dismissed,
    acknowledged: acked,
    parkedKeys: new Set(review.map((r) => r.idempotencyKey)),
    cartEmpty,
  })
  const ref = key ? engine.localReceipts().find((r) => r.idempotencyKey === key)?.orderNumber ?? null : null
  const onAcknowledge = useCallback((k: string) => setAcked(acknowledge(k)), [])
  return {
    review: shown,
    acknowledgedCount: review.length - shown.length,
    onAcknowledge,
    banner: key ? { key, ref: ref ?? 'penjualan' } : null,
    dismissBanner: dismissParkedAlert,
  }
}
