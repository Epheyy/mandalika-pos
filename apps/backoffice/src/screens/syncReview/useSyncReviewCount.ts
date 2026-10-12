import { useEffect } from 'react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'

/** Fired after a resolve so the sidebar badge refreshes at once. */
export const SYNC_REVIEW_CHANGED = 'mandalika:sync-review-changed'
const BADGE_POLL_MS = 60_000

export function useSyncReviewCount(enabled: boolean): number {
  const q = usePolledQuery<number>(
    () => (enabled
      ? api.listSyncReviewItems({ status: 'open', page: 1, limit: 1 }).then((r) => r.openCount)
      : Promise.resolve(0)),
    [enabled],
    BADGE_POLL_MS,
  )
  const { refetch } = q
  useEffect(() => {
    const onChange = () => { void refetch() }
    window.addEventListener(SYNC_REVIEW_CHANGED, onChange)
    return () => window.removeEventListener(SYNC_REVIEW_CHANGED, onChange)
  }, [refetch])
  return q.data ?? 0
}
