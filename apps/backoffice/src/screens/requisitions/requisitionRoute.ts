import { buildHash } from '../../lib/router/hash'
import { isUuidSegment, segmentAfter } from '../../lib/router/tabs'
import type { ListSchema } from '../../lib/router/useListState'

/** Permintaan Barang's views, as paths under #/permintaan-barang. */
export type RequisitionView =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string }

export const REQUISITION_BASE = ['permintaan-barang'] as const

/** "" = list, "/baru" = new request, "/<id>" = detail, "/<id>/ubah" = edit that draft. A segment that is not a uuid is the list. */
export function requisitionViewFromPath(path: readonly string[]): RequisitionView {
  const first = segmentAfter(path, REQUISITION_BASE)
  if (first === undefined) return { kind: 'list' }
  if (first === 'baru') return { kind: 'create' }
  if (!isUuidSegment(first)) return { kind: 'list' }
  return segmentAfter(path, REQUISITION_BASE, 1) === 'ubah' ? { kind: 'edit', id: first } : { kind: 'detail', id: first }
}

export function requisitionHash(view: RequisitionView): string {
  switch (view.kind) {
    case 'list':
      return buildHash(REQUISITION_BASE)
    case 'create':
      return buildHash([...REQUISITION_BASE, 'baru'])
    case 'detail':
      return buildHash([...REQUISITION_BASE, view.id])
    case 'edit':
      return buildHash([...REQUISITION_BASE, view.id, 'ubah'])
  }
}

// ---- list filters (D5b) --------------------------------------------------------------------------------
// #/permintaan-barang?status=&hal=&per=  Defaults stay out of the URL; junk values fall back to them.

export const REQUISITION_PAGE_SIZES = [25, 50, 100] as const
const REQUISITION_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'fulfilled', 'cancelled'] as const
export type RequisitionStatusFilter = (typeof REQUISITION_STATUSES)[number]

export interface RequisitionListQuery extends Record<string, string | number | boolean> {
  status: string
  hal: number
  per: number
}
export const REQUISITION_LIST_SCHEMA: ListSchema<RequisitionListQuery> = {
  status: { key: 'status', default: '' },
  hal: { key: 'hal', default: 1 },
  per: { key: 'per', default: 25 },
}

/** The API takes only known statuses; anything else in the URL means "all". */
export const requisitionStatusOf = (raw: string): RequisitionStatusFilter | '' =>
  (REQUISITION_STATUSES as readonly string[]).includes(raw) ? (raw as RequisitionStatusFilter) : ''

export const requisitionPageOf = (raw: number): number => (Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1)

export const requisitionSizeOf = (raw: number): number =>
  (REQUISITION_PAGE_SIZES as readonly number[]).includes(raw) ? raw : REQUISITION_PAGE_SIZES[0]

/** The list entry, whatever filters it carries: where "Kembali" from a request should land. */
export const isRequisitionListPath = (path: readonly string[]): boolean => requisitionViewFromPath(path).kind === 'list'
