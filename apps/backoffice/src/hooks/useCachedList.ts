import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ScopedCache } from '../lib/scopedCache'
import { useOptionalOutlet } from '../outlet'

export interface CachedList<T> {
  /** The last good list for the current scope; undefined until it loads (and again after a scope switch). */
  data: T | undefined
  error: string | null
  loading: boolean
  /** A visible "Muat ulang": always loads. */
  refetch: () => Promise<void>
}

// Server markup (tests render to a string) has no cache: nothing loaded yet.
const serverEntry = () => undefined
const serverEpoch = () => 0

/** While mounted, how often an entry older than maxAgeMs is noticed and refreshed (a no-op while it is fresh). */
const REVALIDATE_CHECK_MS = 15_000

/**
 * Reads a shared scoped cache instead of polling. Loads on mount (or when `enabled` turns on), serves the
 * cached list while it is younger than `maxAgeMs`, refetches when an invalidation lands, and notices an
 * entry that has aged out while the screen stays open. A failed load keeps the last good list.
 */
export function useCachedList<T>(
  cache: ScopedCache<T>,
  opts: { enabled?: boolean; maxAgeMs?: number } = {},
): CachedList<T> {
  const { enabled = true, maxAgeMs } = opts
  // Re-render when the admin outlet switcher changes the scope the cache reads. The effect keys on the SELECTED
  // outlet, not on authStore.outletId: Opname briefly points the header at another outlet while it creates a count,
  // and that must not start a load of its own.
  const outlet = useOptionalOutlet()
  const entry = useSyncExternalStore(cache.subscribe, cache.peek, serverEntry)
  const epoch = useSyncExternalStore(cache.subscribe, cache.epoch, serverEpoch)
  const scope = outlet ? (outlet.outletId ?? '') : cache.scopeKey()
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () => {
      cache.get({ maxAgeMs }).then(
        () => alive && setFailure(null),
        (e: unknown) => alive && setFailure({ scope, message: e instanceof Error ? e.message : 'load failed' }),
      )
    }
    load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, REVALIDATE_CHECK_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [cache, enabled, maxAgeMs, scope, epoch])

  const refetch = useCallback(async () => {
    try {
      await cache.get({ force: true })
      setFailure(null)
    } catch (e: unknown) {
      setFailure({ scope: cache.scopeKey(), message: e instanceof Error ? e.message : 'load failed' })
    }
  }, [cache])

  const data = entry?.data
  const error = failure && failure.scope === scope ? failure.message : null
  return { data, error, loading: enabled && data === undefined && error === null, refetch }
}
