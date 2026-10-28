import { describe, expect, it } from 'vitest'
import type { LocalReceipt } from '@mandalika/sync'
import {
  LOCAL_BADGE, filterLocalReceipts, localBadge, localReceiptOrder, localSaleRef, newestReprintable, reprintReceiptData,
} from './localReceipts'

const snapshot = {
  v: 1, refVersion: 3, subtotal: 250000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0,
  total: 250000, amountPaid: 300000, change: 50000,
  lines: [{ productId: 'p1', variantSize: '110ml', name: 'Mandalika Oud', qty: 2, unitPrice: 125000, amount: 250000 }],
}
const receipt = (over: Partial<LocalReceipt> = {}): LocalReceipt => ({
  orderUuid: 'u-1', idempotencyKey: 'dev:u-1', orderNumber: 'BSD-G0007', capturedAt: '2026-10-20T03:00:00.000Z', outletId: 'out1',
  shiftId: 'shift-1', paymentMethod: 'qris', quotedTotal: 250000, receiptSnapshot: snapshot, state: 'queued',
  refundQueued: false, refunded: false, ...over,
})

describe('localBadge', () => {
  it('maps every state', () => {
    expect(localBadge(receipt({ state: 'queued' })).label).toBe('Tersimpan di tablet')
    expect(localBadge(receipt({ state: 'parked' })).label).toBe('Perlu ditinjau')
    expect(localBadge(receipt({ state: 'synced' })).label).toBe('Terkirim')
    expect(localBadge(receipt({ state: 'synced', refundQueued: true })).label).toBe('Refund tersimpan di tablet')
    expect(localBadge(receipt({ state: 'synced', refunded: true })).label).toBe('Sudah direfund')
    expect(LOCAL_BADGE).toEqual(['Tersimpan di tablet', 'Perlu ditinjau', 'Terkirim', 'Refund tersimpan di tablet', 'Sudah direfund', 'Sebagian direfund'])
  })

  it('a completed refund wins over a queued one, and a queued refund wins over the sale state', () => {
    expect(localBadge(receipt({ refunded: true, refundQueued: true })).label).toBe('Sudah direfund')
    expect(localBadge(receipt({ state: 'parked', refundQueued: true })).label).toBe('Refund tersimpan di tablet')
  })
})

describe('filterLocalReceipts searches the receipt number only', () => {
  const rows = [receipt(), receipt({ orderUuid: 'u-2', orderNumber: 'BSD-G0008', paymentMethod: 'cash' })]
  it('returns everything for an empty or blank term', () => {
    expect(filterLocalReceipts(rows, '').length).toBe(2)
    expect(filterLocalReceipts(rows, '   ').length).toBe(2)
  })
  it('matches a number fragment, case-insensitively', () => {
    expect(filterLocalReceipts(rows, 'g0008').map((r) => r.orderUuid)).toEqual(['u-2'])
    expect(filterLocalReceipts(rows, ' BSD-G000 ').length).toBe(2)
  })
  it('does not match payment method, uuid, amount or anything else', () => {
    expect(filterLocalReceipts(rows, 'cash')).toEqual([])
    expect(filterLocalReceipts(rows, 'u-2')).toEqual([])
    expect(filterLocalReceipts(rows, '250000')).toEqual([])
    expect(filterLocalReceipts(rows, 'qris')).toEqual([])
  })
})

describe('localReceiptOrder (the dialog row for a refund)', () => {
  it('uses the uuid as identity and builds the lines from the snapshot', () => {
    const o = localReceiptOrder(receipt())
    expect(o).toMatchObject({ id: 'u-1', orderNumber: 'BSD-G0007', total: 250000, paymentMethod: 'qris', shiftId: 'shift-1', status: 'completed' })
    expect(o.items).toEqual([{ productId: 'p1', productName: 'Mandalika Oud', variantSize: '110ml', quantity: 2, price: 125000, subtotal: 250000 }])
  })
  it('falls back to the snapshot total and to no lines when data is missing', () => {
    const o = localReceiptOrder(receipt({ quotedTotal: null, receiptSnapshot: null }))
    expect(o.total).toBe(0)
    expect(o.items).toEqual([])
    expect(localReceiptOrder(receipt({ quotedTotal: null })).total).toBe(250000)
  })
  it('has no customer or salesman fields', () => {
    const json = JSON.stringify(localReceiptOrder(receipt()))
    expect(json).not.toMatch(/customer|salesman|phone/i)
  })
})

describe('localSaleRef', () => {
  it('carries the uuid and, when known, the server id', () => {
    expect(localSaleRef(receipt())).toEqual({ orderUuid: 'u-1' })
    expect(localSaleRef(receipt({ serverOrderId: 'srv-1' }))).toEqual({ orderUuid: 'u-1', serverOrderId: 'srv-1' })
  })
})

describe('reprintReceiptData', () => {
  it('rebuilds the slip from the snapshot only, with no customer and a dash for the cashier', () => {
    const d = reprintReceiptData(receipt())!
    expect(d).toMatchObject({
      orderRef: 'BSD-G0007', pending: false, paymentLabel: 'QRIS', customerName: null, customerPhone: null, cashierName: '-',
      subtotal: 250000, total: 250000, amountPaid: 300000, change: 50000,
    })
    expect(d.lines).toEqual([{ name: 'Mandalika Oud', variant: '110ml', qty: 2, unitPrice: 125000, amount: 250000 }])
    expect(d.dateTime.toISOString()).toBe('2026-10-20T03:00:00.000Z')
  })
  it('is null when the snapshot is missing or malformed (nothing to print)', () => {
    expect(reprintReceiptData(receipt({ receiptSnapshot: null }))).toBeNull()
    expect(reprintReceiptData(receipt({ receiptSnapshot: { v: 3, lines: [] } }))).toBeNull()
    expect(reprintReceiptData(receipt({ receiptSnapshot: { v: 1, lines: 'x' } }))).toBeNull()
    expect(reprintReceiptData(receipt({ quotedTotal: null }))).toBeNull()
  })
  it('newestReprintable skips rows that cannot be printed', () => {
    const rows = [receipt({ orderUuid: 'a', receiptSnapshot: null }), receipt({ orderUuid: 'b' }), receipt({ orderUuid: 'c' })]
    expect(newestReprintable(rows)?.orderUuid).toBe('b')
    expect(newestReprintable([])).toBeNull()
  })
})

describe('C4b local receipt lines for a per-line refund', () => {
  const base = (over: Record<string, unknown> = {}) => receipt({
    receiptSnapshot: {
      v: 2, total: 150000, lines: [
        { productId: 'a', variantSize: '50ml', name: 'A', qty: 2, unitPrice: 50000, amount: 100000 },
        { productId: 'g', variantSize: '', name: 'Gratis', qty: 1, unitPrice: 0, amount: 0, isReward: true },
        { productId: 'tas', variantSize: '', name: 'Tas', qty: 1, unitPrice: 0, amount: 0, isReward: true },
      ],
    },
    quotedTotal: 100000, lineNets: [100000, 0], lineGroups: [null, 'bxgy:p:1'], ...over,
  } as never)

  it('gives sale lines their position, net share and group, and marks the trailing bag as the giveaway', () => {
    const o = localReceiptOrder(base()) as unknown as { items: Record<string, unknown>[] }
    expect(o.items.map((i) => i.lineNo)).toEqual([0, 1, undefined])
    expect(o.items.map((i) => i.netAmount)).toEqual([100000, 0, undefined])
    expect(o.items[1].refundGroup).toBe('bxgy:p:1')
    expect(o.items[2].isGiveaway).toBe(true)
  })

  it('without line data the order stays whole-refund only (no lineNo / net on any line)', () => {
    const o = localReceiptOrder(base({ lineNets: undefined, lineGroups: undefined })) as unknown as { items: Record<string, unknown>[] }
    expect(o.items.every((i) => i.lineNo === undefined && i.netAmount === undefined)).toBe(true)
  })

  it('ignores line data that does not fit the snapshot (never guesses a mapping)', () => {
    const o = localReceiptOrder(base({ lineNets: [1, 2, 3, 4] })) as unknown as { items: Record<string, unknown>[] }
    expect(o.items.every((i) => i.lineNo === undefined)).toBe(true)
  })

  it('badges a part-refunded sale and a sale whose every unit is back', () => {
    expect(localBadge(receipt({ state: 'synced' }), { any: true, exhausted: false, remaining: 500 }).label).toBe('Sebagian direfund')
    expect(localBadge(receipt({ state: 'synced' }), { any: true, exhausted: true, remaining: 0 }).label).toBe('Sudah direfund')
    expect(localBadge(receipt({ state: 'synced', refundQueued: true }), { any: true, exhausted: false, remaining: 500 }).label).toBe('Refund tersimpan di tablet')
  })
})
