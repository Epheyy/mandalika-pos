import type { Product, StockCount } from '@mandalika/api'

/** The bit of the auth store the scope helper switches (the header outlet every request sends as X-Outlet-Id). */
export interface OutletScopeStore {
  outletId: string | null
}

/**
 * Runs one opname call under the opname's own outlet. Under the header scope "Semua outlet" (`outletId === null`)
 * the server resolves no outlet for the caller, so an outlet count answers "not found"; sending the count's own
 * outlet fixes that. A warehouse count (or a row with no outlet) is exempt server-side and runs as it is. The
 * previous scope is always restored, even when the call throws.
 */
const queues = new WeakMap<OutletScopeStore, Promise<unknown>>()

export async function withCountScope<T>(
  store: OutletScopeStore,
  count: Pick<StockCount, 'outletId' | 'warehouseId'>,
  fn: () => Promise<T>,
): Promise<T> {
  if (count.warehouseId || !count.outletId) return fn()
  const outletId = count.outletId
  // The scope is one global value, so scoped calls take turns: two overlapping saves (different lines run in
  // parallel) must not interleave their save/restore and leave the admin stuck on one outlet.
  const run = async (): Promise<T> => {
    const prev = store.outletId
    store.outletId = outletId
    try {
      return await fn()
    } finally {
      store.outletId = prev
    }
  }
  const turn = (queues.get(store) ?? Promise.resolve()).then(run, run)
  queues.set(store, turn.catch(() => undefined))
  return turn
}

const NOT_FOUND_TEXT = 'Opname tidak ditemukan. Muat ulang halaman; bila masih gagal, pilih outlet opname ini di bagian atas lalu coba lagi.'

/** A raw "not found" from the server becomes a sentence the user can act on; any other message passes through. */
export function countErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof Error) || !e.message.trim()) return fallback
  return /^not found$/i.test(e.message.trim()) ? NOT_FOUND_TEXT : e.message
}

/** Newest first. The server already sends this order; sorting here keeps it when a page is merged or refreshed. */
export function newestFirst<T extends Pick<StockCount, 'createdAt'>>(counts: readonly T[]): T[] {
  return [...counts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/** The scope a new count freezes: "{n} produk aktif ({m} baris varian ukuran)" (variants of the active products). */
export function freezeSummary(products: readonly Pick<Product, 'variants'>[]): string {
  const variants = products.reduce((sum, p) => sum + p.variants.length, 0)
  return `${products.length} produk aktif (${variants} baris varian ukuran)`
}
