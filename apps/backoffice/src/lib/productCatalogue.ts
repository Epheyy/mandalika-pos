import type { Product } from '@mandalika/api'
import { api, authStore, catalogueSignal } from '../api'
import { loadAllProducts } from './loadAll'
import { createScopedCache } from './scopedCache'

/** How long the full product list is served before the next screen that wants it refetches. */
export const CATALOGUE_TTL_MS = 5 * 60_000

/**
 * Every product (active and inactive, unfiltered) as the signed-in user and the active outlet header see it.
 * `/products` carries per-outlet stock and PAR levels, so the scope is user + X-Outlet-Id, and a consumer
 * that needs only active products filters the list itself.
 */
export const productCatalogue = createScopedCache<Product[]>({
  load: () => loadAllProducts((page, limit) => api.listProducts(page, limit)),
  scope: () => `${authStore.userId ?? ''}|${authStore.outletId ?? ''}`,
  ttlMs: CATALOGUE_TTL_MS,
})

// A product, its variants, its outlet config or stock changed in this tab (see catalogueSignal in api.ts):
// every cached list is stale and mounted readers refetch.
catalogueSignal.onChanged = () => productCatalogue.invalidate()

export const activeProducts = (all: readonly Product[] | undefined): Product[] | undefined =>
  all?.filter((p) => p.isActive)
