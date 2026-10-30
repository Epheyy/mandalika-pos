import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { aggregate } from './recapAggregate'
import { orderReceiptTenders } from './refundView'
import { draftBelongsToSale, splitDraftFromState } from './splitDraft'
import { CASHIER_INITIAL_STATE, cashierReducer } from './state/cashierReducer'
import { cashPredicate, tenderStructureError } from './tenderSplit'

// Opus review of C6b (H1, H3, M1, M2 and the reducer lows).
type Order = components['schemas']['Order']

const methods = [
  { id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true },
  { id: 'qris', label: 'QRIS', isEnabled: true },
]
const T = (seq: number, method: string, amount: number, reference?: string) =>
  ({ seq, method, amount, tendered: amount, change: 0, synthetic: false, ...(reference ? { reference } : {}) })
const split = (over: Record<string, unknown> = {}): Order => ({
  id: 'o1', orderNumber: 'BSD-G0007', status: 'completed', total: 1251000, subtotal: 1251000, discountAmount: 0, taxAmount: 0,
  paymentMethod: 'split', items: [], tenders: [T(1, 'qris', 751000, '8812345'), T(2, 'tunai', 500000)], ...over,
}) as unknown as Order

describe('H3: a fully refunded split order still moves money between methods in the recap', () => {
  it('QRIS 751k + Tunai 500k refunded whole in cash: cash -751k, QRIS +751k, totals untouched', () => {
    const o = split({ status: 'refunded', refundedAmount: 1251000, refunds: [{ seq: 1, amount: 1251000, paymentMethod: 'tunai' }] })
    const b = aggregate([o], methods)
    expect(b.byMethod).toEqual({ qris: 751000, tunai: 500000 - 1251000 })
    expect(b.cashSales).toBe(500000 - 1251000)
    expect(b.totalSales).toBe(0)
    expect(b.totalOrders).toBe(0)
    expect(b.refundCount).toBe(1)
    expect(b.refundTotal).toBe(1251000)
    expect(b.gross).toBe(0)
  })
  it('a fully refunded single-method order stays out of the buckets entirely (byte-identical to before)', () => {
    const o = split({ paymentMethod: 'qris', tenders: [T(1, 'qris', 1251000)], status: 'refunded', refundedAmount: 1251000, refunds: [{ seq: 1, amount: 1251000, paymentMethod: 'qris' }] })
    // One real line refunded in the same method nets to zero: no bucket row appears.
    expect(aggregate([o], methods).byMethod).toEqual({})
    const legacy = split({ paymentMethod: 'qris', tenders: undefined, status: 'refunded', refundedAmount: 1251000 })
    expect(aggregate([legacy], methods).byMethod).toEqual({})
    const synthetic = split({ paymentMethod: 'qris', tenders: [{ ...T(1, 'qris', 1251000), synthetic: true }], status: 'refunded', refundedAmount: 1251000 })
    expect(aggregate([synthetic], methods).byMethod).toEqual({})
  })
})

describe('H1: the sale-time delete takes only the draft of that sale', () => {
  const state = (() => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'SPLIT_START', orderUuid: 'draft-uuid' })
    s = cashierReducer(s, { type: 'SPLIT_RESTORE', orderUuid: 'draft-uuid', tenders: [{ method: 'qris', amount: 751000 }] })
    return s
  })()
  const draft = splitDraftFromState(state, 1251000, cashPredicate(methods), Date.now())
  it('a plain sale (a different uuid) leaves an unrestored draft alone', () => {
    expect(draftBelongsToSale(draft, 'plain-sale-uuid')).toBe(false)
    expect(draftBelongsToSale(null, 'draft-uuid')).toBe(false)
  })
  it('the split sale that used the draft uuid takes it', () => {
    expect(draftBelongsToSale(draft, 'draft-uuid')).toBe(true)
  })
})

describe('M1: the POS refuses every reference the server refuses', () => {
  const line = (reference: string) => [{ method: 'qris', amount: 100, reference }, { method: 'tunai', amount: 100 }]
  it.each([
    ['NBSP', 'AB CD'],
    ['zero-width space', 'AB​CD'],
    ['soft hyphen', 'AB­CD'],
    ['BOM', 'AB﻿CD'],
    ['ideographic space', 'AB　CD'],
    ['en quad', 'AB CD'],
    ['tab', 'AB\tCD'],
    ['line separator', 'AB CD'],
  ])('rejects %s', (_n, ref) => {
    expect(tenderStructureError(line(ref))).not.toBeNull()
  })
  it('accepts ordinary references, spaces and non-ASCII letters', () => {
    expect(tenderStructureError(line('8812345'))).toBeNull()
    expect(tenderStructureError(line('REF 12-34/A_b'))).toBeNull()
    expect(tenderStructureError(line('Éé 東京'))).toBeNull()
  })
})

describe('M2: a history reprint lists the tender lines', () => {
  it('maps a split order to one slip row per captured line, with the reference', () => {
    const rows = orderReceiptTenders(split({ tenders: [T(1, 'qris', 751000, '8812345'), { ...T(2, 'tunai', 500000), tendered: 600000, change: 100000 }] }), methods)
    expect(rows).toEqual([{ label: 'QRIS', amount: 751000, reference: '8812345' }, { label: 'Tunai', amount: 600000 }])
  })
  it('a plain sale (one line, no reference) keeps its single payment row', () => {
    expect(orderReceiptTenders(split({ paymentMethod: 'qris', tenders: [T(1, 'qris', 1251000)] }), methods)).toBeUndefined()
    expect(orderReceiptTenders(split({ tenders: undefined }), methods)).toBeUndefined()
  })
})

describe('reducer lows', () => {
  it('switching the method drops a reference typed for the old one', () => {
    const s = cashierReducer({ ...CASHIER_INITIAL_STATE, paymentMethod: 'qris', tenderReference: '8812345' }, { type: 'SET_PAYMENT_METHOD', method: 'card' })
    expect(s.tenderReference).toBe('')
  })
})
