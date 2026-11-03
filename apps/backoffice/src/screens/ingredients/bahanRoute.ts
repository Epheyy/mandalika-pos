/*
 * Bahan's Daftar and Transfer tabs as URL state (D4). Pure; junk values fall back to the default.
 *   #/inventori/bahan/daftar?q=&kategori=&hal=&per=
 *   #/inventori/bahan/transfer?status=&lokasi=&dari=&sampai=&hal=&per=
 * The ingredient transfer detail stays an inline row expansion (it is transient UI state, not a place).
 */
import { isUuidSegment } from '../../lib/router/tabs'
import type { ListSchema } from '../../lib/router/useListState'

export const BAHAN_PAGE_SIZES = [25, 50, 100] as const

export const bahanPageOf = (raw: number): number => (Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1)
export const bahanSizeOf = (raw: number): number =>
  (BAHAN_PAGE_SIZES as readonly number[]).includes(raw) ? raw : BAHAN_PAGE_SIZES[0]

export interface DaftarQuery extends Record<string, string | number | boolean> {
  q: string
  kategori: string
  hal: number
  per: number
}
export const DAFTAR_SCHEMA: ListSchema<DaftarQuery> = {
  q: { key: 'q', default: '' },
  kategori: { key: 'kategori', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

export const TRANSFER_STATUSES = ['draft', 'in_transit', 'completed', 'cancelled'] as const

export interface BahanTransferQuery extends Record<string, string | number | boolean> {
  status: string
  lokasi: string
  dari: string
  sampai: string
  hal: number
  per: number
}
export const BAHAN_TRANSFER_SCHEMA: ListSchema<BahanTransferQuery> = {
  status: { key: 'status', default: '' },
  lokasi: { key: 'lokasi', default: '' },
  dari: { key: 'dari', default: '' },
  sampai: { key: 'sampai', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

export const transferStatusOf = (raw: string): string => ((TRANSFER_STATUSES as readonly string[]).includes(raw) ? raw : '')

/** "outlet:<uuid>" or "warehouse:<uuid>"; anything else means every location. */
export function bahanLocationOf(raw: string): string {
  const [kind, id, ...rest] = raw.split(':')
  return rest.length === 0 && (kind === 'outlet' || kind === 'warehouse') && id !== undefined && isUuidSegment(id) ? raw : ''
}

/** A calendar day "YYYY-MM-DD" that really exists; anything else means no bound. */
export function bahanDayOf(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return ''
  const d = new Date(`${raw}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? '' : raw
}

/** The category filter is a client-side match on the current page; only a uuid can match, so junk means all. */
export const categoryOf = (raw: string): string => (isUuidSegment(raw) ? raw : '')
