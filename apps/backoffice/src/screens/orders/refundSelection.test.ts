import { describe, expect, it } from 'vitest'
import {
  buildReason, canPartialRefundStatus, estimateRefund, lineLockReason, refundErrorMessage, refundFlagLabel,
  remainingRefundable, selectionToItems, setLineQty, EMPTY_SELECTION, type RefundableItem,
} from './refundSelection'

const solo: RefundableItem = { lineNo: 1, quantity: 3, refundedQty: 1, price: 100, netAmount: 270 }
const g1: RefundableItem = { lineNo: 2, quantity: 1, refundGroup: 'b', price: 50, netAmount: 40 }
const g2: RefundableItem = { lineNo: 3, quantity: 2, refundGroup: 'b', price: 10, netAmount: 20 }
const legacy: RefundableItem = { lineNo: null, quantity: 1, price: 5 }
const items = [solo, g1, g2, legacy]

describe('setLineQty', () => {
  it('clamps to 0..remaining', () => {
    expect(setLineQty(items, EMPTY_SELECTION, 1, 9)).toEqual({ 1: 2 })
    expect(setLineQty(items, { 1: 2 }, 1, -4)).toEqual({})
  })
  it('selects and clears a whole group at full remaining qty', () => {
    expect(setLineQty(items, EMPTY_SELECTION, 2, 1)).toEqual({ 2: 1, 3: 2 })
    expect(setLineQty(items, { 2: 1, 3: 2 }, 3, 0)).toEqual({})
  })
  it('refuses a group that was partly refunded before', () => {
    const part = [{ ...g1, refundedQty: 1 }, g2]
    expect(lineLockReason(part[1], part)).toMatch(/sebagian/)
    expect(setLineQty(part, EMPTY_SELECTION, 3, 1)).toEqual({})
  })
  it('locks legacy lines and fully refunded lines', () => {
    expect(lineLockReason(legacy, items)).toMatch(/Order lama/)
    expect(lineLockReason({ ...solo, refundedQty: 3 }, items)).toMatch(/Sudah/)
    expect(setLineQty(items, EMPTY_SELECTION, 1, 1)).toEqual({ 1: 1 })
  })
})

describe('selection helpers', () => {
  it('blocks an empty selection', () => {
    expect(selectionToItems({})).toEqual([])
    expect(selectionToItems({ 3: 2, 1: 1 })).toEqual([{ lineNo: 1, quantity: 1 }, { lineNo: 3, quantity: 2 }])
  })
  it('estimates net share, falling back to price*qty', () => {
    expect(estimateRefund(items, { 1: 2 })).toBe(180) // 270*2/3
    expect(estimateRefund([{ lineNo: 4, quantity: 2, price: 30 }], { 4: 1 })).toBe(30)
  })
})

describe('buildReason', () => {
  it('maps presets to label + slug', () => {
    expect(buildReason('rusak_cacat', '')).toEqual({ ok: true, reason: 'Rusak/cacat', reasonCode: 'rusak_cacat' })
  })
  it('requires text for Lainnya and rejects unknown', () => {
    expect(buildReason('lainnya', '  ').ok).toBe(false)
    expect(buildReason('lainnya', ' x ')).toEqual({ ok: true, reason: 'x', reasonCode: 'lainnya' })
    expect(buildReason('', '').ok).toBe(false)
  })
})

describe('display helpers', () => {
  it('remainingRefundable', () => {
    expect(remainingRefundable({ status: 'partially_refunded', total: 100, refundedAmount: 130 })).toBe(0)
    expect(remainingRefundable({ status: 'partially_refunded', total: 100, refundedAmount: 40 })).toBe(60)
    expect(remainingRefundable({ status: 'refunded', total: 100 })).toBe(0)
    expect(remainingRefundable({ status: 'completed', total: 100 })).toBe(100)
    expect(remainingRefundable({ status: 'partially_refunded', total: 100 })).toBeNull()
  })
  it('flags, status gate, errors', () => {
    expect(refundFlagLabel('amount_mismatch')).toBe('Jumlah beda')
    expect(refundFlagLabel('over_total')).toBe('Melebihi total')
    expect(refundFlagLabel(null)).toBeNull()
    expect(canPartialRefundStatus('completed')).toBe(true)
    expect(canPartialRefundStatus('refunded')).toBe(false)
    expect(refundErrorMessage(409, 'x')).toMatch(/refund lain/)
    expect(refundErrorMessage(400, 'bad')).toBe('bad')
  })
})
