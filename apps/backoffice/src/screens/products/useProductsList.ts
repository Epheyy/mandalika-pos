import { useCallback, useEffect, useMemo } from 'react'
import { fetchAllPages, type Category, type ListResult, type Product, type ProductListFilter } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { buildExportName, exportToCSV, exportToXLSX } from '../../lib/csvUtils'
import { productExportRows } from '../../lib/productExport'
import { useListState } from '../../lib/router/useListState'
import { useOutlet } from '../../outlet'
import type { ExportFormat } from '../../ui/ExportButton'
import {
  PRODUCTS_SCHEMA,
  activeFilterCount,
  clampPage,
  describeFilters,
  isPastLastPage,
  normalizeProductsList,
  toProductFilter,
  type ProductsListState,
} from './productsListState'

type ListPatch = Partial<ProductsListState>

/**
 * The Produk list: URL state (q, status, kategori, stok, urut, hal, per), the server page for it, export of every
 * matching row. It fetches on a filter change and polls only the visible page; the catalogue is never walked here.
 */
export function useProductsList(categories: readonly Category[]) {
  const { outletId, outlets } = useOutlet()
  const [rawState, setRawState] = useListState(PRODUCTS_SCHEMA)
  const state = useMemo(() => normalizeProductsList(rawState), [rawState])
  // Keyed by content: opening the editor changes the URL but must not refetch (and blank) the list.
  const filterKey = JSON.stringify(toProductFilter(state))
  const filter = useMemo(() => JSON.parse(filterKey) as ProductListFilter, [filterKey])

  const { hal, per } = state
  const query = usePolledQuery<ListResult<Product>>(
    () => api.listProducts(hal, per, filter),
    // The header outlet scopes stock, price and availability, so a switch refetches.
    [outletId, hal, per, filter],
  )
  const rows = query.data?.data ?? []
  const total = query.data?.meta?.total ?? 0

  // The server answers total 0 beyond the last page: ask for the real total once, then step back to the last page.
  const pastEnd = query.data !== undefined && isPastLastPage(hal, rows.length)
  useEffect(() => {
    if (!pastEnd) return
    let alive = true
    api
      .listProducts(1, 1, filter)
      .then((r) => alive && setRawState({ hal: clampPage(hal, r.meta?.total ?? 0, per) }, { replace: true }))
      .catch(() => alive && setRawState({ hal: 1 }, { replace: true }))
    return () => {
      alive = false
    }
  }, [pastEnd, hal, per, filter, setRawState])

  /** A filter change goes back to page 1 in the same move; typing a search replaces the entry instead of adding one. */
  const setFilter = useCallback(
    (patch: ListPatch) => setRawState({ ...patch, hal: 1 }, { replace: 'q' in patch }),
    [setRawState],
  )
  const setPage = useCallback((page: number) => setRawState({ hal: page }), [setRawState])
  const setPageSize = useCallback((size: number) => setRawState({ per: size, hal: 1 }), [setRawState])
  const reset = useCallback(
    () => setRawState({ q: '', status: '', kategori: '', stok: '', urut: 'terbaru', hal: 1 }),
    [setRawState],
  )

  const categoryName = useCallback((id: string | null | undefined) => categories.find((c) => c.id === id)?.name, [categories])
  const filterSummary = useMemo(() => describeFilters(state, categoryName), [state, categoryName])

  // Every product that matches the filters, not just the visible page; one row per variant, base price.
  const exportAll = useCallback(
    async (format: ExportFormat) => {
      const all = await fetchAllPages((page, limit) => api.listProducts(page, limit, filter))
      if (all.length === 0) return
      const exportRows = productExportRows(all, (id) => categoryName(id) ?? '')
      // The product list is outlet-scoped (X-Outlet-Id); name the file by that scope.
      const scope = outletId ? (outlets.find((o) => o.id === outletId)?.name ?? null) : 'semua-outlet'
      const name = buildExportName('produk', [scope, ...filterSummary])
      if (format === 'xlsx') exportToXLSX(exportRows, name)
      else exportToCSV(exportRows, name)
    },
    [filter, outletId, outlets, filterSummary, categoryName],
  )

  return {
    state,
    rows,
    total,
    loaded: query.data !== undefined,
    loading: query.loading || pastEnd,
    error: query.error,
    refetch: query.refetch,
    activeCount: activeFilterCount(state),
    filterSummary,
    setFilter,
    setPage,
    setPageSize,
    reset,
    setOverlay: setRawState,
    exportAll,
  }
}
