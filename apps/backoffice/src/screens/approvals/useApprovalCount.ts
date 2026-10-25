import { useEffect } from 'react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'

/** Fired after an approve/reject so the sidebar badge refreshes at once. */
export const APPROVALS_CHANGED = 'mandalika:approvals-changed'
const BADGE_POLL_MS = 60_000

export function notifyApprovalsChanged(): void {
  window.dispatchEvent(new Event(APPROVALS_CHANGED))
}

export function useApprovalCount(enabled: boolean): number {
  const q = usePolledQuery<number>(
    () => (enabled
      ? api.listInventoryApprovals(1, 1).then((r) => r.pendingCount)
      : Promise.resolve(0)),
    [enabled],
    BADGE_POLL_MS,
  )
  const { refetch } = q
  useEffect(() => {
    const onChange = () => { void refetch() }
    window.addEventListener(APPROVALS_CHANGED, onChange)
    return () => window.removeEventListener(APPROVALS_CHANGED, onChange)
  }, [refetch])
  return q.data ?? 0
}
