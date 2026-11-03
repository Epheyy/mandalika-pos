import type { ProductListFilter } from '@mandalika/api'
import type { ListSchema } from '../../lib/router/useListState'
import { isUuidSegment } from '../../lib/router/tabs'

/** Rows per page the list offers (the backend turns a limit above 200 into 50). */
export const PRODUCT_PAGE_SIZES: readonly number[] = [25, 50, 100]
export const DEFAULT_PAGE_SIZE = 25

/** A product with an active variant at or below this many units is "Stok rendah" (D-81, same as the POS). */
export const LOW_STOCK_MAX = 2

export const STATUS_ITEMS = [
  { id: '', label: 'Semua' },
  { id: 'aktif', label: 'Aktif' },
  { id: 'nonaktif', label: 'Nonaktif' },
] as const

export const STOCK_ITEMS = [
  { id: '', label: 'Semua stok' },
  { id: 'low', label: 'Stok rendah' },
  { id: 'out', label: 'Habis' },
] as const

export const SORT_OPTIONS = [
  { value: 'terbaru', label: 'Terbaru' },
  { value: 'nama', label: 'Nama A-Z' },
] as const

/**
 * The list's URL state (D-69: Indonesian keys, API codes as values). `ubah` and `baru` are the editor overlay:
 * `?ubah=<id>` edits a product, `?baru=1` starts a new one.
 */
export type ProductsListState = {
  q: string
  status: string
  kategori: string
  stok: string
  urut: string
  hal: number
  per: number
  ubah: string
  baru: boolean
}

export const PRODUCTS_SCHEMA: ListSchema<ProductsListState> = {
  q: { key: 'q', default: '' },
  status: { key: 'status', default: '' },
  kategori: { key: 'kategori', default: '' },
  stok: { key: 'stok', default: '' },
  urut: { key: 'urut', default: 'terbaru' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: DEFAULT_PAGE_SIZE },
  ubah: { key: 'ubah', default: '' },
  baru: { key: 'baru', default: false },
}

const oneOf = (value: string, allowed: readonly string[], fallback: string): string => (allowed.includes(value) ? value : fallback)

/** A pasted URL is untrusted: anything outside the known codes falls back to the default before it reaches the API. */
export function normalizeProductsList(state: ProductsListState): ProductsListState {
  const hal = Number.isFinite(state.hal) ? Math.max(1, Math.floor(state.hal)) : 1
  return {
    q: state.q,
    status: oneOf(state.status, ['aktif', 'nonaktif'], ''),
    kategori: isUuidSegment(state.kategori) ? state.kategori : '',
    stok: oneOf(state.stok, ['low', 'out'], ''),
    urut: oneOf(state.urut, ['terbaru', 'nama'], 'terbaru'),
    hal,
    per: PRODUCT_PAGE_SIZES.includes(state.per) ? state.per : DEFAULT_PAGE_SIZE,
    ubah: state.ubah,
    baru: state.baru,
  }
}

/** Server parameters for a (normalized) state. Empty values are left out so the URL carries no `q=`. */
export function toProductFilter(state: ProductsListState): ProductListFilter {
  const q = state.q.trim()
  return {
    ...(q ? { q } : {}),
    ...(state.kategori ? { categoryId: state.kategori } : {}),
    ...(state.status ? { active: state.status === 'aktif' } : {}),
    ...(state.stok === 'low' || state.stok === 'out' ? { stock: state.stok } : {}),
    ...(state.urut === 'nama' ? { sort: 'nama' as const } : {}),
  }
}

/** Number of filters that differ from the default (the "Atur ulang filter" count). */
export function activeFilterCount(state: ProductsListState): number {
  return [state.q.trim() !== '', state.status !== '', state.kategori !== '', state.stok !== '', state.urut !== 'terbaru'].filter(Boolean).length
}

/** Plain-words filter list for the export tooltip and file name. */
export function describeFilters(state: ProductsListState, categoryName: (id: string) => string | undefined): string[] {
  const label = (items: readonly { id?: string; value?: string; label: string }[], code: string) =>
    items.find((i) => (i.id ?? i.value) === code)?.label ?? code
  return [
    ...(state.q.trim() ? [`Cari: ${state.q.trim()}`] : []),
    ...(state.status ? [`Status: ${label(STATUS_ITEMS, state.status)}`] : []),
    ...(state.kategori ? [`Kategori: ${categoryName(state.kategori) ?? 'tidak dikenal'}`] : []),
    ...(state.stok ? [`Stok: ${label(STOCK_ITEMS, state.stok)}`] : []),
    ...(state.urut !== 'terbaru' ? [`Urutan: ${label(SORT_OPTIONS, state.urut)}`] : []),
  ]
}

/** The last page that can hold rows for `total` rows (page 1 when there are none). */
export function clampPage(page: number, total: number, per: number): number {
  const lastPage = Math.max(1, Math.ceil(total / per))
  return Math.min(Math.max(1, page), lastPage)
}

/** An empty page past the first: the server answers total 0 beyond the last page, so the screen has to step back. */
export const isPastLastPage = (page: number, rowCount: number): boolean => page > 1 && rowCount === 0

export type StockLevel = 'out' | 'low' | 'ok'

export function stockLevel(stock: number): StockLevel {
  if (stock <= 0) return 'out'
  return stock <= LOW_STOCK_MAX ? 'low' : 'ok'
}

/** "Habis", "2 (rendah)" or "12": the colour of a stock badge never carries the meaning alone. */
export function stockText(stock: number): string {
  const level = stockLevel(stock)
  if (level === 'out') return 'Habis'
  return level === 'low' ? `${stock} (rendah)` : String(stock)
}
