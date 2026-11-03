import { buildHash } from '../../lib/router/hash'
import { segmentAfter } from '../../lib/router/tabs'

/** Permintaan Barang's views, as paths under #/permintaan-barang. */
export type RequisitionView =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string }

export const REQUISITION_BASE = ['permintaan-barang'] as const

/** "" = list, "/baru" = new request, "/<id>" = detail, "/<id>/ubah" = edit that draft. */
export function requisitionViewFromPath(path: readonly string[]): RequisitionView {
  const first = segmentAfter(path, REQUISITION_BASE)
  if (first === undefined) return { kind: 'list' }
  if (first === 'baru') return { kind: 'create' }
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
