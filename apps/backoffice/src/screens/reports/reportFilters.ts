import type { ListSchema } from '../../lib/router/useListState'
import { isUuidSegment } from '../../lib/router/tabs'

/*
 * Laporan filters as URL query state (D4). Pure parse/normalise helpers: a value from the URL is never
 * trusted, so each reader falls back to the default for junk (a stale or hand-typed link).
 */

export const PAGE_SIZES: readonly number[] = [25, 50, 100]
export const DEFAULT_PAGE_SIZE = 50
/** Past this the page is surely junk; it also keeps the number printable in an API query. */
const MAX_PAGE = 100000

/** hal, as a whole number >= 1. */
export function pageOf(raw: number): number {
  if (!Number.isFinite(raw)) return 1
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(raw)))
}

/** per, one of the sizes the pager offers. */
export function pageSizeOf(raw: number): number {
  return PAGE_SIZES.includes(raw) ? raw : DEFAULT_PAGE_SIZE
}

/** One of `allowed`, else `fallback`. */
export function enumOf<T extends string>(raw: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

/** A record id from the URL; the server answers 400 for a non-uuid, so junk means "no filter". */
export function uuidOf(raw: string): string {
  return isUuidSegment(raw) ? raw : ''
}

const MAX_PAYMENT_ID = 64

/**
 * A payment method id from the URL. Settings builds ids from what the owner types (lower-cased, spaces to "_"),
 * so "debit/kredit_bca" or "e-wallet_(ovo)" are real ids: anything trimmed, non-empty, without control
 * characters and within the cap passes (it is URL-encoded on the way out and a query parameter on the way in).
 */
export function paymentOf(raw: string): string {
  const id = raw.trim()
  if (id === '' || id.length > MAX_PAYMENT_ID) return ''
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(id) ? '' : id
}

/** The options plus the current value when it is not among them, so a select never shows a different value from the one in force. */
export function withCurrent<T extends { id: string; label: string }>(options: readonly T[], current: string): Array<T | { id: string; label: string }> {
  if (current === '' || options.some((o) => o.id === current)) return [...options]
  return [...options, { id: current, label: current }]
}

/** What the URL carries for a day the user cleared (an unbounded range end); '' itself means "the default". */
export const UNBOUNDED_DAY = 'semua'

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day as YYYY-MM-DD (rejects 2026-13-45). */
export function isDay(raw: string): boolean {
  if (!DAY.test(raw)) return false
  const [y, m, d] = raw.split('-').map(Number)
  // Date.UTC maps years 0-99 to 1900-1999, which would reject a year typed digit by digit ("0002-10-01").
  const date = new Date(0)
  date.setUTCFullYear(y, m - 1, d)
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * dari/sampai from the URL. '' (absent) and junk give `fallback`, which the caller computes from today so it
 * never goes stale in a module constant; UNBOUNDED_DAY gives '' (no bound), the state of a cleared date input.
 */
export function dayOf(raw: string, fallback: string): string {
  if (raw === UNBOUNDED_DAY) return ''
  return isDay(raw) ? raw : fallback
}

/** The URL value for what a date input now holds; a cleared input is kept as UNBOUNDED_DAY, not the default. */
export function dayToQuery(value: string): string {
  return value === '' ? UNBOUNDED_DAY : value
}

/**
 * The page to move to when the one on show lies past the end of what the server has (the last row of the last page
 * was refunded, or a stale link): the last page, or 1 when nothing matches. null = the page is fine.
 */
export function pageToClamp(page: number, total: number, pageSize: number): number | null {
  if (page <= 1) return null
  const last = Math.max(1, Math.ceil(total / pageSize))
  return page > last ? last : null
}

/**
 * Whether a list answer belongs to the page on show. usePolledQuery keeps the previous answer (loading=false) for
 * the render in which its deps changed, so a clamp that trusts it would rewrite the entry Back just restored.
 * `limit` is checked only where the page size can change (pass undefined for a fixed-size list).
 */
export function isAnswerFor(meta: { page?: number; limit?: number } | null | undefined, page: number, limit?: number): boolean {
  if (!meta || meta.page !== page) return false
  return limit === undefined || meta.limit === limit
}

/**
 * The date range survives a switch between the tabs that share it (everything but Transaksi, which keeps its own
 * 30-day window); every other key belongs to the tab it was set on and is dropped.
 */
export function carriedDays(
  query: Readonly<Record<string, string>>,
  fromTab: string,
  toTab: string,
  ordersTab = 'orders',
): { dari?: string; sampai?: string } {
  if (fromTab === ordersTab || toTab === ordersTab) return {}
  return { dari: query.dari, sampai: query.sampai }
}

export interface PagingState {
  hal: number
  per: number
  [key: string]: string | number
}

/** hal/per for the tabs that page with a size picker (the default stays out of the URL). */
export const PAGING_SCHEMA: ListSchema<PagingState> = {
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: DEFAULT_PAGE_SIZE },
}

export interface PageOnlyState {
  hal: number
  [key: string]: string | number
}

/** hal only, for the tabs with a fixed page size. */
export const PAGE_ONLY_SCHEMA: ListSchema<PageOnlyState> = {
  hal: { key: 'hal', default: 1 },
}

/** Pages in a server-paged set: at least 1, even for an empty set. */
export function totalPagesOf(total: number, limit: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return 1
  return Math.max(1, Math.ceil(total / limit))
}

/** Message for a range whose start is after its end ('' on either side = unbounded, always fine); null when valid. */
export function dateRangeError(from: string, to: string): string | null {
  return from !== '' && to !== '' && from > to
    ? 'Tanggal "Dari" lebih akhir dari "Sampai". Ubah rentang tanggal agar data tampil.'
    : null
}
