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
  const generation = useRef(0)
  const request = useRef(0)
  const active = useRef(false)

  const run = useCallback(async (owner: number) => {
    // A queued interval callback from a cleaned-up effect must not start work.
    if (!active.current || owner !== generation.current) return
    const token = ++request.current
    const mayPublish = () => active.current && owner === generation.current && token === request.current
    try {
      const r = await fetcherRef.current()
      if (mayPublish()) {
        setData(r)
        setError(null)
      }
    } catch (e: unknown) {
      if (!mayPublish()) return
      setError(e instanceof Error ? e.message : 'load failed')
    } finally {
      if (mayPublish()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const owner = ++generation.current
    active.current = true
    // Clear data from the previous deps (e.g. the prior outlet) so a context
    // switch shows the loading skeleton instead of stale numbers from another
    // scope. The interval poll keeps deps stable, so it stays stale-while-revalidate.
    setData(undefined)
    setError(null)
    setLoading(true)
    void run(owner)
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void run(owner)
    }, intervalMs)
    return () => {
      active.current = false
      ++generation.current
      clearInterval(id)
    }
    // `deps` is a caller-forwarded array, not an inline literal, so neither
    // linter can statically check it — intentional for a generic polling hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps
  }, deps)

  const refetch = useCallback(() => run(generation.current), [run])
  return { data, error, loading, refetch }
}
