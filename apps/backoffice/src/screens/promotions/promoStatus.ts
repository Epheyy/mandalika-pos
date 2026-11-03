import type { Tone } from '../../lib/labels'

export type PromoStatusCode = 'aktif' | 'terjadwal' | 'berakhir' | 'nonaktif'

/** Rows offered by the Status filter (API codes; labels come from PROMOTION_STATUS). */
export const PROMO_STATUS_CODES: readonly PromoStatusCode[] = ['aktif', 'terjadwal', 'berakhir', 'nonaktif']

const WIB_OFFSET_MS = 7 * 3_600_000

/**
 * The business day (WIB, Asia/Jakarta) of an instant as YYYY-MM-DD. The server compares promotion dates with
 * `(now() AT TIME ZONE 'Asia/Jakarta')::date`, so the badge must not use the browser's own zone. Indonesia has
 * no DST, so a fixed +7 h is exact.
 */
export function wibDay(now: Date = new Date()): string {
  return new Date(now.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10)
}

interface Dated {
  isActive: boolean
  startDate?: string | null
  endDate?: string | null
}

/**
 * The derived status, in the precedence of the server's status filter (read/promotions_page.go):
 * inactive first, then ended (end < today), then not yet started (start > today), else active.
 * `today` is a YYYY-MM-DD string compared as text, like the server's date comparison.
 */
export function promoStatus(row: Dated, today: string): PromoStatusCode {
  if (!row.isActive) return 'nonaktif'
  if (row.endDate && row.endDate < today) return 'berakhir'
  if (row.startDate && row.startDate > today) return 'terjadwal'
  return 'aktif'
}

export const toneOfStatus = (code: PromoStatusCode): Tone => (code === 'aktif' ? 'ok' : code === 'terjadwal' ? 'info' : 'neutral')
