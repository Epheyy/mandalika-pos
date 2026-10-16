import { useEffect } from 'react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { OVERSELL_CHANGED } from './oversellLabels'

const BADGE_POLL_MS = 60_000

/**
 * Unchecked oversell lines in the caller's scope (A44 badge). The outlet rides the
 * request header, so `outletId` is a dependency only (switching outlets refetches).
 */
export function useOversellOpenCount(enabled: boolean, outletId: string | null): number {
  const q = usePolledQuery<number>(
    () => (enabled ? api.getOversellOpenCount() : Promise.resolve(0)),
    [enabled, outletId],
    BADGE_POLL_MS,
  )
  const { refetch } = q
  useEffect(() => {
    const onChange = () => { void refetch() }
    window.addEventListener(OVERSELL_CHANGED, onChange)
    return () => window.removeEventListener(OVERSELL_CHANGED, onChange)
  }, [refetch])
  return q.data ?? 0
}
