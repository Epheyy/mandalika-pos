import type { components } from '@mandalika/api'

export type Transfer = components['schemas']['Transfer']
export type ReceiveApprover = components['schemas']['ReceiveApprover']
export type TransferItem = components['schemas']['TransferItem']
export type Bundle = components['schemas']['SyncPullBundle']

/** In-transit transfers carried in the snapshot (already dest-scoped server-side). */
export function inboundTransfers(bundle: Bundle): Transfer[] {
  return (bundle.transfers ?? []).filter((t) => t.status === 'in_transit')
}

export function receiveApprovers(bundle: Bundle): ReceiveApprover[] {
  return bundle.receiveApprovers ?? []
}
