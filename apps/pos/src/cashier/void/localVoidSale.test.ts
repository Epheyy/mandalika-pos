import { describe, expect, it } from 'vitest'
import type { LocalReceipt } from '@mandalika/sync'
import { localVoidSale } from './localVoidSale'

const receipt = (over: Partial<LocalReceipt> = {}): LocalReceipt => ({
  orderUuid: 'u1', idempotencyKey: 'dev:u1', orderNumber: 'BSD-0001', capturedAt: '2026-11-14T03:00:00Z', outletId: 'o', shiftId: 'sh1',
  paymentMethod: 'cash', quotedTotal: 100000, state: 'queued', refundQueued: false, refunded: false,
  receiptSnapshot: { total: 90000, lines: [{ productId: 'p1', variantSize: '50ml', name: 'A', qty: 2, unitPrice: 50000, amount: 100000 }, { productId: 'g', variantSize: 'STD', name: 'Tas', qty: 1, unitPrice: 0, amount: 0 }] },
  tenders: [{ method: 'cash', amount: 120000 }],
  ...over,
} as LocalReceipt)

describe('localVoidSale', () => {
  it('maps total, lines (giveaway line included), tenders, shift and flags', () => {
    const s = localVoidSale(receipt({ voidQueued: true }))
    expect(s).toMatchObject({
      orderUuid: 'u1', orderNumber: 'BSD-0001', total: 100000, shiftId: 'sh1', paymentMethod: 'cash', voidQueued: true, voided: false, refunded: false,
      tenders: [{ method: 'cash', amount: 120000 }],
    })
    expect(s.lines).toEqual([{ productId: 'p1', variantSize: '50ml', quantity: 2 }, { productId: 'g', variantSize: 'STD', quantity: 1 }])
    expect('serverOrderId' in s).toBe(false)
  })

  it('falls back to the snapshot total, and omits lines for an unreadable snapshot', () => {
    expect(localVoidSale(receipt({ quotedTotal: null })).total).toBe(90000)
    const s = localVoidSale(receipt({ receiptSnapshot: null, serverOrderId: 'srv1', voided: true }))
    expect(s).toMatchObject({ total: 100000, serverOrderId: 'srv1', voided: true })
    expect('lines' in s).toBe(false)
  })
})
