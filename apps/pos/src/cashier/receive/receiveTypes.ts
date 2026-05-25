import type { components } from '@mandalika/api'

export type Transfer = components['schemas']['Transfer']
export type ReceiveApprover = components['schemas']['ReceiveApprover']
export type TransferItem = components['schemas']['TransferItem']
export type Bundle = components['schemas']['SyncPullBundle']

export function receiveApprovers(bundle: Bundle): ReceiveApprover[] {
  return bundle.receiveApprovers ?? []
}
