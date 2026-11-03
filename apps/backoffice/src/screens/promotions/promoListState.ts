import type { PromoListParams } from '@mandalika/api'
import { DISCOUNT_CODE_TYPE, PROMOTION_STATUS, PROMOTION_TYPE } from '../../lib/labels'
import type { ListSchema } from '../../lib/router/useListState'
import { PROMO_STATUS_CODES } from './promoStatus'

/** Rows per page the lists offer (the backend turns a limit above 200 into 50). */
export const PROMO_PAGE_SIZES: readonly number[] = [25, 50, 100]
export const DEFAULT_PAGE_SIZE = 25

export type PromoListKind = 'promotions' | 'codes'

/**
 * The URL state of both lists (D-69: Indonesian keys, API codes as values). `status` is the derived status
 * (aktif, terjadwal, berakhir, nonaktif: the date window lives in it), `jenis` the promotion or code type.
 * `ubah` / `baru` are the editor overlay: `?ubah=<id>` edits one row, `?baru=1` starts a new one.
 */
export type PromoListState = {
  q: string
  status: string
  jenis: string
  hal: number
  per: number
  ubah: string
  baru: boolean
}

export const PROMO_LIST_SCHEMA: ListSchema<PromoListState> = {
  q: { key: 'q', default: '' },
  status: { key: 'status', default: '' },
  jenis: { key: 'jenis', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: DEFAULT_PAGE_SIZE },
  ubah: { key: 'ubah', default: '' },
  baru: { key: 'baru', default: false },
}

const typeMapOf = (kind: PromoListKind) => (kind === 'promotions' ? PROMOTION_TYPE : DISCOUNT_CODE_TYPE)
const oneOf = (value: string, allowed: readonly string[]): string => (allowed.includes(value) ? value : '')

/** A pasted URL is untrusted: anything outside the known codes falls back to the default before it reaches the API. */
export function normalizePromoList(state: PromoListState, kind: PromoListKind): PromoListState {
  return {
    q: state.q,
    status: oneOf(state.status, PROMO_STATUS_CODES),
    jenis: oneOf(state.jenis, Object.keys(typeMapOf(kind))),
    hal: Number.isFinite(state.hal) ? Math.max(1, Math.floor(state.hal)) : 1,
    per: PROMO_PAGE_SIZES.includes(state.per) ? state.per : DEFAULT_PAGE_SIZE,
    ubah: state.ubah,
    baru: state.baru,
  }
}

/** Server filter parameters for a (normalized) state. Empty values are left out. */
export function toPromoFilter(state: PromoListState): Pick<PromoListParams, 'q' | 'status' | 'type'> {
  const q = state.q.trim()
  return {
    ...(q ? { q } : {}),
    ...(state.status ? { status: state.status as PromoListParams['status'] } : {}),
    ...(state.jenis ? { type: state.jenis } : {}),
  }
}

/** Number of filters that differ from the default (the "Atur ulang filter" count). */
export const activePromoFilterCount = (state: PromoListState): number =>
  [state.q.trim() !== '', state.status !== '', state.jenis !== ''].filter(Boolean).length

/** Plain-words filter list for the export tooltip and file name. */
export function describePromoFilters(state: PromoListState, kind: PromoListKind): string[] {
  const statusLabel = PROMOTION_STATUS[state.status as keyof typeof PROMOTION_STATUS]?.label ?? state.status
  const typeMap = typeMapOf(kind) as Record<string, { label: string }>
  return [
    ...(state.q.trim() ? [`Cari: ${state.q.trim()}`] : []),
    ...(state.status ? [`Status: ${statusLabel}`] : []),
    ...(state.jenis ? [`Jenis: ${typeMap[state.jenis]?.label ?? state.jenis}`] : []),
  ]
}

/** The last page that can hold rows for `total` rows (page 1 when there are none). */
export function clampPage(page: number, total: number, per: number): number {
  const lastPage = Math.max(1, Math.ceil(total / per))
  return Math.min(Math.max(1, page), lastPage)
}

/** An empty page past the first: the server answers total 0 beyond the last page, so the screen has to step back. */
export const isPastLastPage = (page: number, rowCount: number): boolean => page > 1 && rowCount === 0
