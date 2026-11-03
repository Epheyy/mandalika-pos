import { useCallback, useEffect, useMemo } from 'react'
import { fetchAllPages, type ListResult, type PromoListParams } from '@mandalika/api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { useListState } from '../../lib/router/useListState'
import {
  PROMO_LIST_SCHEMA,
  activePromoFilterCount,
  clampPage,
  describePromoFilters,
  isPastLastPage,
  normalizePromoList,
  toPromoFilter,
  type PromoListKind,
  type PromoListState,
} from './promoListState'

type ListPatch = Partial<PromoListState>

/**
 * One promotion or discount-code list: URL state, the server page for it, and a way to fetch every matching row for
 * the export. It fetches on a filter change and polls only the visible page. The overlay keys (`ubah`, `baru`) are
 * part of the state but never refetch the list (the filter is keyed by content).
 */
export function usePromoList<T extends { id: string }>(
  kind: PromoListKind,
  fetchPage: (params: PromoListParams) => Promise<ListResult<T>>,
) {
  const [rawState, setRawState] = useListState(PROMO_LIST_SCHEMA)
  const state = useMemo(() => normalizePromoList(rawState, kind), [rawState, kind])
  const filterKey = JSON.stringify(toPromoFilter(state))
  const filter = useMemo(() => JSON.parse(filterKey) as ReturnType<typeof toPromoFilter>, [filterKey])

  const { hal, per } = state
  const query = usePolledQuery<ListResult<T>>(() => fetchPage({ ...filter, page: hal, limit: per }), [hal, per, filter])
  const rows = query.data?.data ?? []
  const total = query.data?.meta?.total ?? 0

  // The server answers total 0 beyond the last page: ask for the real total once, then step back to the last page.
  const pastEnd = query.data !== undefined && isPastLastPage(hal, rows.length)
  // Not while the editor is open: stepping back is a navigation, and a dirty editor's leave guard would ask about it.
  const overlayOpen = state.ubah !== '' || state.baru
  useEffect(() => {
    if (!pastEnd || overlayOpen) return
    let alive = true
    fetchPage({ ...filter, page: 1, limit: 1 })
      .then((r) => alive && setRawState({ hal: clampPage(hal, r.meta?.total ?? 0, per) }, { replace: true }))
      .catch(() => alive && setRawState({ hal: 1 }, { replace: true }))
    return () => {
      alive = false
    }
  }, [pastEnd, overlayOpen, hal, per, filter, fetchPage, setRawState])

  /** A filter change goes back to page 1 in the same move; typing a search replaces the entry instead of adding one. */
  const setFilter = useCallback((patch: ListPatch) => setRawState({ ...patch, hal: 1 }, { replace: 'q' in patch }), [setRawState])
  const setPage = useCallback((page: number) => setRawState({ hal: page }), [setRawState])
  const setPageSize = useCallback((size: number) => setRawState({ per: size, hal: 1 }), [setRawState])
  const reset = useCallback(() => setRawState({ q: '', status: '', jenis: '', hal: 1 }), [setRawState])

  const filterSummary = useMemo(() => describePromoFilters(state, kind), [state, kind])

  // Every row that matches the filters, not just the visible page.
  const fetchEvery = useCallback(() => fetchAllPages<T>((page, limit) => fetchPage({ ...filter, page, limit })), [fetchPage, filter])

  return {
    state,
    rows,
    total,
    loaded: query.data !== undefined,
    loading: query.loading || pastEnd,
    error: query.error,
    refetch: query.refetch,
    activeCount: activePromoFilterCount(state),
    filterSummary,
    setFilter,
    setPage,
    setPageSize,
    reset,
    setOverlay: setRawState,
    fetchEvery,
  }
}
