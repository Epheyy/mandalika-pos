import { useCallback, useEffect, useRef, useState } from 'react'

export interface PolledQuery<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  refetch: () => Promise<void>
}

/**
 * Polling replacement for Firestore `onSnapshot`: runs `fetcher` on mount and
 * every `intervalMs` while the tab is visible. `deps` re-run the fetch when
 * they change (e.g. active outlet switch). Errors are surfaced, not thrown.
 */
export function usePolledQuery<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  intervalMs = 12000,
): PolledQuery<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const alive = useRef(true)

  const run = useCallback(async () => {
    try {
      const r = await fetcherRef.current()
      if (!alive.current) return
      setData(r)
      setError(null)
    } catch (e: unknown) {
      if (!alive.current) return
      setError(e instanceof Error ? e.message : 'load failed')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    // Clear data from the previous deps (e.g. the prior outlet) so a context
    // switch shows the loading skeleton instead of stale numbers from another
    // scope. The interval poll keeps deps stable, so it stays stale-while-revalidate.
    setData(undefined)
    setLoading(true)
    void run()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void run()
    }, intervalMs)
    return () => {
      alive.current = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading, refetch: run }
}
