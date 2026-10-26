import type { LocalReceipt } from '@mandalika/sync'

export type OrderState = 'queued' | 'parked' | 'synced' | 'unknown'

/** The sync state of the sale just made, read from the engine's own local receipts by sale uuid
 *  (`state.lastOrderId` is the order uuid). 'unknown' when there is no id or no matching receipt. */
export function orderStateFor(receipts: readonly Pick<LocalReceipt, 'orderUuid' | 'state'>[], orderUuid: string | null): OrderState {
  if (!orderUuid) return 'unknown'
  return receipts.find((r) => r.orderUuid === orderUuid)?.state ?? 'unknown'
}
