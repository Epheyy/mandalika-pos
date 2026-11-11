import { useEffect, useRef } from 'react'
import { pastEndPage } from '../screens/customersPastEnd'

interface PastEndAnswer {
  loading: boolean
  data: { meta?: { page?: number } } | null | undefined
}

/**
 * The page a paged list should replace itself with, or null to stay. Only an answer to THIS page
 * counts (a poll hook keeps the previous answer for a render), and only once loaded; then an empty
 * page above 1 goes to min(page - 1, totalPages) (the server reports the real total past the end).
 */
export function pastEndRedirect(q: PastEndAnswer, page: number, rowCount: number, totalPages: number): number | null {
  if (q.loading || !q.data || q.data.meta?.page !== page) return null
  return pastEndPage(page, totalPages, rowCount)
}

/** Calls `go(target)` (a replace-style page change) when the list answered an empty page past the end. */
export function usePastEndRedirect(q: PastEndAnswer, page: number, rowCount: number, totalPages: number, go: (page: number) => void): void {
  const target = pastEndRedirect(q, page, rowCount, totalPages)
  const goRef = useRef(go) // callers pass an inline closure; the redirect must fire once per target, not per render
  useEffect(() => {
    goRef.current = go
  })
  useEffect(() => {
    if (target !== null) goRef.current(target)
  }, [target])
}
