/*
 * Pelanggan's places and list filters as URL state (D4). Pure: parsed from the hash path and query, tested in node.
 *   #/pelanggan/daftar?q=&urut=&tag=&segmen=&hal=&per=      the list (a bare #/pelanggan is the same)
 *   #/pelanggan/daftar/<id>                                  a customer; #/pelanggan/<id> opens it too
 *   #/pelanggan/pengingat?hari=&jenis=&hal=                  reminders; /pengingat/<id> opens the customer over them
 *   #/pelanggan/duplikat[/<id>]                              duplicate review
 *   #/pelanggan/loyalitas[/kondisi]                          loyalty settings / special conditions
 */
import { buildHash } from '../../lib/router/hash'
import { isUuidSegment, segmentAfter } from '../../lib/router/tabs'
import type { ListSchema } from '../../lib/router/useListState'

export type CustomerView = 'daftar' | 'pengingat' | 'duplikat' | 'loyalitas'
export type LoyaltySub = 'general' | 'conditions'

export const CUSTOMER_BASE = ['pelanggan'] as const

export interface CustomerPlace {
  /** The customer page, over the list or the reminders. */
  customerId: string | null
  /** The duplicate under review. */
  dupId: string | null
  loyaltySub: LoyaltySub
}

/** What the path names under the tab `view` (the tab itself comes from useScreenTabs). */
export function customerPlace(path: readonly string[], view: CustomerView): CustomerPlace {
  const second = segmentAfter(path, CUSTOMER_BASE)
  const third = segmentAfter(path, CUSTOMER_BASE, 1)
  const bareId = second !== undefined && isUuidSegment(second) ? second : null
  const tabId = third !== undefined && isUuidSegment(third) ? third : null
  return {
    customerId: view === 'daftar' || view === 'pengingat' ? (bareId ?? tabId) : null,
    dupId: view === 'duplikat' ? tabId : null,
    loyaltySub: view === 'loyalitas' && third === 'kondisi' ? 'conditions' : 'general',
  }
}

export const customerListHash = (view: CustomerView): string => buildHash([...CUSTOMER_BASE, view])
export const customerHash = (view: 'daftar' | 'pengingat', id: string): string => buildHash([...CUSTOMER_BASE, view, id])
export const dupReviewHash = (id: string): string => buildHash([...CUSTOMER_BASE, 'duplikat', id])
export const loyaltyHash = (sub: LoyaltySub): string =>
  buildHash([...CUSTOMER_BASE, 'loyalitas', ...(sub === 'conditions' ? ['kondisi'] : [])])

/** A path that shows `view` itself (no customer page or review over it): where "Kembali" should land. */
export function isListPath(path: readonly string[], view: CustomerView): boolean {
  if (path[0] !== CUSTOMER_BASE[0]) return false
  const { customerId, dupId } = customerPlace(path, view)
  if (customerId !== null || dupId !== null) return false
  const slug = path[1]
  return slug === undefined ? view === 'daftar' : slug === view
}

// ---- list filters ------------------------------------------------------------------------------------

export const CUSTOMER_PAGE_SIZES = [25, 50, 100] as const
export const REMINDER_PAGE_SIZE = 25
export type CustomerSort = 'belanja' | 'terbaru'
export const CUSTOMER_SORTS: readonly CustomerSort[] = ['belanja', 'terbaru']
export type ReminderType = 'all' | 'birthday' | 'anniversary'
export const REMINDER_TYPES: readonly ReminderType[] = ['all', 'birthday', 'anniversary']

export interface CustomerListQuery extends Record<string, string | number | boolean> {
  q: string
  urut: string
  tag: string
  segmen: string
  hal: number
  per: number
}
export const CUSTOMER_LIST_SCHEMA: ListSchema<CustomerListQuery> = {
  q: { key: 'q', default: '' },
  urut: { key: 'urut', default: 'belanja' },
  tag: { key: 'tag', default: '' },
  segmen: { key: 'segmen', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

export interface ReminderListQuery extends Record<string, string | number | boolean> {
  hari: number
  jenis: string
  hal: number
}
export const REMINDER_LIST_SCHEMA: ListSchema<ReminderListQuery> = {
  hari: { key: 'hari', default: 7 },
  jenis: { key: 'jenis', default: 'all' },
  hal: { key: 'hal', default: 1 },
}

/** A page number from the URL: a whole number, 1 or more. */
export const pageOf = (raw: number): number => (Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1)

export const pageSizeOf = (raw: number): number =>
  (CUSTOMER_PAGE_SIZES as readonly number[]).includes(raw) ? raw : CUSTOMER_PAGE_SIZES[0]

export const sortOf = (raw: string): CustomerSort => ((CUSTOMER_SORTS as readonly string[]).includes(raw) ? (raw as CustomerSort) : 'belanja')

/** The API takes tag and segment ids as uuids; anything else in the URL means "all". */
export const idOf = (raw: string): string => (isUuidSegment(raw) ? raw : '')

export const reminderWindowOf = (raw: number): 7 | 30 => (raw === 30 ? 30 : 7)

export const reminderTypeOf = (raw: string): ReminderType =>
  (REMINDER_TYPES as readonly string[]).includes(raw) ? (raw as ReminderType) : 'all'
