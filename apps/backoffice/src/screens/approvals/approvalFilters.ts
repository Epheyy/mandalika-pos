import type { ApprovalListFilter } from '@mandalika/api'

export type ApprovalKind = NonNullable<ApprovalListFilter['kind']>

const KINDS: readonly ApprovalKind[] = ['adjustment', 'count']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A kind from the URL; anything else (a stale or pasted link) means "all kinds". */
export function kindOf(value: string): ApprovalKind | '' {
  return (KINDS as readonly string[]).includes(value) ? (value as ApprovalKind) : ''
}

/** An outlet id from the URL; the server answers 400 for a non-uuid, so junk means "follow the header". */
export function outletOf(value: string): string {
  return UUID.test(value) ? value : ''
}

/** Query for the queue: only what was chosen. The sidebar badge never goes through this. */
export function approvalFilterOf(state: { outlet: string; jenis: string }): ApprovalListFilter {
  const outletId = outletOf(state.outlet)
  const kind = kindOf(state.jenis)
  return { ...(outletId ? { outletId } : {}), ...(kind ? { kind } : {}) }
}
