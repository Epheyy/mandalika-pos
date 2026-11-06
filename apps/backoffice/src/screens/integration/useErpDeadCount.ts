import { useEffect } from 'react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'

/** Fired after a retry or a relay run so the sidebar badge refreshes at once. */
export const ERP_OUTBOX_CHANGED = 'mandalika:erp-outbox-changed'
const BADGE_POLL_MS = 60_000

/** Documents the ERP gave up on (status "dead"): the same list call as the screen, one row, only `meta.total` read. */
export function useErpDeadCount(enabled: boolean): number {
  const q = usePolledQuery<number>(
    () => (enabled
      ? api.listErpOutbox({ status: 'dead', page: 1, limit: 1 }).then((r) => r.meta?.total ?? 0)
      : Promise.resolve(0)),
    [enabled],
    BADGE_POLL_MS,
  )
  const { refetch } = q
  useEffect(() => {
    const onChange = () => { void refetch() }
    window.addEventListener(ERP_OUTBOX_CHANGED, onChange)
    return () => window.removeEventListener(ERP_OUTBOX_CHANGED, onChange)
  }, [refetch])
  return q.data ?? 0
}
