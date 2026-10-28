import { describe, expect, it } from 'vitest'
import type { LocalReceipt } from '@mandalika/sync'
import { REFUND_VIA_HISTORY_OFFLINE, localReceiptOrder, refundViaHistory } from './localReceipts'

const line = { productId: 'a', variantSize: '', name: 'A', qty: 1, unitPrice: 100, amount: 100 }
const receipt = (over: Partial<LocalReceipt> = {}): LocalReceipt => ({
  orderUuid: 'u-1', idempotencyKey: 'dev:u-1', orderNumber: 'N-1', capturedAt: '2026-10-20T03:00:00.000Z', outletId: 'o', shiftId: 's',
  paymentMethod: 'cash', quotedTotal: 100, receiptSnapshot: { v: 2, total: 100, lines: [line] }, state: 'synced', refundQueued: false, refunded: false, ...over,
})

describe('refundViaHistory', () => {
  it('is true for a synced receipt without line data', () => {
    expect(refundViaHistory({ serverOrderId: 'srv' }, localReceiptOrder(receipt()))).toBe(true)
  })
  it('is false for an unsynced sale (no server id yet)', () => {
    expect(refundViaHistory({}, localReceiptOrder(receipt({ state: 'queued' })))).toBe(false)
  })
  it('is false when the receipt carries line data', () => {
    const withLines = receipt({ lineNets: [100], lineGroups: [null] })
    expect(refundViaHistory({ serverOrderId: 'srv' }, localReceiptOrder(withLines))).toBe(false)
  })
  it('has a plain offline message', () => {
    expect(REFUND_VIA_HISTORY_OFFLINE).toBe('Refund struk ini lewat Riwayat saat online.')
  })
})
