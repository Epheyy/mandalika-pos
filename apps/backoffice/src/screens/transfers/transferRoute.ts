import { buildHash } from '../../lib/router/hash'
import { isUuidSegment, segmentAfter } from '../../lib/router/tabs'

/** The Transfer tab's three views, as paths under #/inventori/transfer. */
export type TransferView = { kind: 'list' } | { kind: 'create' } | { kind: 'detail'; id: string }

export const TRANSFER_BASE = ['inventori', 'transfer'] as const

/** "#/inventori/transfer" = list, ".../baru" = the create form, ".../<id>" = that transfer. A segment that is not a uuid is the list. */
export function transferViewFromPath(path: readonly string[]): TransferView {
  const seg = segmentAfter(path, TRANSFER_BASE)
  if (seg === undefined) return { kind: 'list' }
  if (seg === 'baru') return { kind: 'create' }
  return isUuidSegment(seg) ? { kind: 'detail', id: seg } : { kind: 'list' }
}

export function transferHash(view: TransferView): string {
  if (view.kind === 'list') return buildHash(TRANSFER_BASE)
  return buildHash([...TRANSFER_BASE, view.kind === 'create' ? 'baru' : view.id])
}
