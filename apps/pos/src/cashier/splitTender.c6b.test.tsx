import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import type { LocalReceipt, QueuedRefund } from '@mandalika/sync'
import { aggregate } from './recapAggregate'
import { refundRecap } from './refundRecap'
import { RefundDialog } from './RefundDialog'
import { localHistoryFor } from './customerProfile'
import { localReceiptOrder } from './localReceipts'
import {
  defaultPayoutMethod, methodCellLabel, paidByText, payoutChoices, planRefundSubmit, prepareRefund, tenderLineText, visibleTenders,
} from './refundView'

type Order = components['schemas']['Order']

const methods = [
  { id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true },
  { id: 'qris', label: 'QRIS', isEnabled: true },
  { id: 'card', label: 'Kartu', isEnabled: true },
]
const T = (seq: number, method: string, amount: number, reference?: string) =>
  ({ seq, method, amount, tendered: amount, change: 0, synthetic: false, ...(reference ? { reference } : {}) })
const order = (over: Record<string, unknown> = {}): Order => ({
  id: 'o1', orderNumber: 'BSD-G0007', status: 'completed', total: 1251000, subtotal: 1251000, discountAmount: 0, taxAmount: 0,
  paymentMethod: 'split', shiftId: 'shift-0', items: [], tenders: [T(1, 'qris', 751000, '8812345'), T(2, 'tunai', 500000)], ...over,
}) as unknown as Order
const single = (over: Record<string, unknown> = {}): Order => order({ paymentMethod: 'qris', tenders: [T(1, 'qris', 1251000)], ...over })

describe('payout chips (D-56/D-57)', () => {
  it('offers chips for a split order only', () => {
    expect(payoutChoices(order(), methods).map((c) => c.id)).toEqual(['qris', 'tunai'])
    expect(payoutChoices(single(), methods)).toEqual([])
    expect(payoutChoices(single({ tenders: undefined }), methods)).toEqual([])
  })
  it('adds a cash method from the settings when the sale had no cash line', () => {
    const o = order({ tenders: [T(1, 'qris', 700000), T(2, 'card', 551000)] })
    expect(payoutChoices(o, methods).map((c) => c.id)).toEqual(['qris', 'card', 'tunai'])
    expect(payoutChoices(o, methods).map((c) => c.label)).toEqual(['QRIS', 'Kartu', 'Tunai'])
  })
  it('preselects the cash line, else the largest line, ties to the lowest seq', () => {
    expect(defaultPayoutMethod(order(), methods)).toBe('tunai')
    expect(defaultPayoutMethod(order({ tenders: [T(1, 'qris', 300000), T(2, 'card', 951000)] }), methods)).toBe('card')
    expect(defaultPayoutMethod(order({ tenders: [T(2, 'card', 600000), T(1, 'qris', 600000)] }), methods)).toBe('qris')
  })
  it('has no default for a single-method order', () => {
    expect(defaultPayoutMethod(single(), methods)).toBeNull()
  })
  it('without settings, cash and tunai still read as cash', () => {
    expect(defaultPayoutMethod(order({ tenders: [T(1, 'qris', 1), T(2, 'cash', 2)] }))).toBe('cash')
  })
})

describe('refund payload payoutMethod', () => {
  const base = { reason: 'rusak', canRefund: true, shiftId: 'shift-1' }
  it('carries payoutMethod for a split order only', () => {
    const split = prepareRefund({ ...base, order: order(), tenders: order().tenders, payoutMethod: 'qris' })
    expect(split.ok && split.payload.payoutMethod).toBe('qris')
    const one = prepareRefund({ ...base, order: single(), tenders: single().tenders, payoutMethod: 'qris' })
    expect(one.ok && 'payoutMethod' in one.payload).toBe(false)
  })
  it('a single-method payload is byte-identical to the legacy one', () => {
    const legacy = prepareRefund({ ...base, order: single({ tenders: undefined }) })
    const now = planRefundSubmit({ refundOrder: single(), orderId: 'o1', ...base, payoutMethod: 'tunai', methods })
    expect(now.kind === 'enqueue' && JSON.stringify(now.payload)).toBe(legacy.ok && JSON.stringify(legacy.payload))
  })
  it('planRefundSubmit sends the chosen chip, else the D-56 default', () => {
    const chosen = planRefundSubmit({ refundOrder: order(), orderId: 'o1', ...base, payoutMethod: 'qris', methods })
    expect(chosen.kind === 'enqueue' && chosen.payload.payoutMethod).toBe('qris')
    const dflt = planRefundSubmit({ refundOrder: order(), orderId: 'o1', ...base, methods })
    expect(dflt.kind === 'enqueue' && dflt.payload.payoutMethod).toBe('tunai')
  })
  it('payoutPicked: true for a tapped chip, false when the preselected default was kept, absent off split orders', () => {
    const tapped = planRefundSubmit({ refundOrder: order(), orderId: 'o1', ...base, payoutMethod: 'qris', payoutPicked: true, methods })
    expect(tapped.kind === 'enqueue' && tapped.payload.payoutPicked).toBe(true)
    // the dialog always passes the preselected chip as payoutMethod; payoutPicked=false marks it as untouched
    const kept = planRefundSubmit({ refundOrder: order(), orderId: 'o1', ...base, payoutMethod: 'tunai', payoutPicked: false, methods })
    expect(kept.kind === 'enqueue' && kept.payload.payoutMethod).toBe('tunai')
    expect(kept.kind === 'enqueue' && kept.payload.payoutPicked).toBe(false)
    // no chip passed at all = the default was used, not picked
    const none = planRefundSubmit({ refundOrder: order(), orderId: 'o1', ...base, methods })
    expect(none.kind === 'enqueue' && none.payload.payoutPicked).toBe(false)
    const one = planRefundSubmit({ refundOrder: single(), orderId: 'o1', ...base, payoutMethod: 'tunai', payoutPicked: true, methods })
    expect(one.kind === 'enqueue' && 'payoutPicked' in one.payload).toBe(false)
  })
})

describe('RefundDialog for a split order', () => {
  const html = (o: Order) => renderToStaticMarkup(createElement(RefundDialog, { order: o, methods, isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn() }))
  it('shows how it was paid and the payout chips with the default pressed', () => {
    const h = html(order())
    expect(h.replace(/\s/g, ' ')).toMatch(/Dibayar QRIS Rp\s*751\.000 \+ Tunai Rp\s*500\.000/)
    expect(h).toContain('Dikembalikan lewat')
    expect(h).toMatch(/aria-pressed="true"[^>]*>Tunai</)
    expect(h).toMatch(/aria-pressed="false"[^>]*>QRIS</)
  })
  it('a single-method order has no payout chips and the old wording', () => {
    const h = html(single())
    expect(h).not.toContain('Dikembalikan lewat')
    expect(h).toContain('Dibayar lewat QRIS')
  })
})

describe('history and receipt lines', () => {
  it('names the method cell "Split-Payment" and lists lines only when useful', () => {
    expect(methodCellLabel(order(), methods)).toBe('Split-Payment')
    expect(methodCellLabel(single(), methods)).toBe('QRIS')
    expect(visibleTenders(order()).length).toBe(2)
    expect(visibleTenders(single())).toEqual([])
    expect(visibleTenders(single({ tenders: [T(1, 'qris', 1251000, 'R1')] })).length).toBe(1)
    expect(visibleTenders({ tenders: undefined })).toEqual([])
  })
  it('formats a line and the dialog summary', () => {
    expect(tenderLineText({ method: 'qris', amount: 751000, reference: '8812345' }, methods).replace(/\s/g, ' ')).toMatch(/^QRIS · Ref 8812345 {2}Rp 751\.000$/)
    expect(paidByText(order(), methods).replace(/\s/g, ' ')).toBe('QRIS Rp 751.000 + Tunai Rp 500.000')
  })
  const receipt = {
    orderUuid: 'u', idempotencyKey: 'k', orderNumber: 'N', capturedAt: '2026-10-30T00:00:00Z', outletId: 'o', shiftId: 's',
    paymentMethod: 'split', quotedTotal: 1251000, receiptSnapshot: { lines: [] }, state: 'queued', refundQueued: false, refunded: false,
    tenders: [{ method: 'qris', amount: 751000, reference: '8812345' }, { method: 'cash', amount: 600000 }],
  } as unknown as LocalReceipt
  it('builds Order.tenders from a local receipt (applied amounts) and leaves old receipts alone', () => {
    const o = localReceiptOrder(receipt)
    expect(o.tenders?.map((t) => [t.method, t.amount, t.tendered, t.change])).toEqual([['qris', 751000, 751000, 0], ['cash', 500000, 600000, 100000]])
    expect(o.tenders?.[0].reference).toBe('8812345')
    expect('tenders' in localReceiptOrder({ ...receipt, tenders: undefined })).toBe(false)
  })
  it('labels a split receipt in the customer profile history', () => {
    expect(localHistoryFor([{ ...receipt, state: 'synced' }])[0].paymentMethod).toBe('Split-Payment')
  })
})

describe('shift recap per tender line', () => {
  it('counts each line under its method and cash from the cash line, refunds by payout method', () => {
    const o = order({ status: 'partially_refunded', refundedAmount: 100000, refunds: [{ seq: 1, amount: 100000, paymentMethod: 'tunai' }] })
    const b = aggregate([o], methods)
    expect(b.byMethod).toEqual({ qris: 751000, tunai: 400000 })
    expect(b.cashSales).toBe(400000)
    expect(b.totalSales).toBe(1151000)
    expect(Object.values(b.byMethod).reduce((a, c) => a + c, 0)).toBe(b.totalSales)
  })
  it('a refund with no payout method falls back to the order method', () => {
    const o = single({ status: 'partially_refunded', refundedAmount: 1000, refunds: [{ seq: 1, amount: 1000 }] })
    expect(aggregate([o], methods).byMethod).toEqual({ qris: 1250000 })
  })
  it('an order without tenders, or with only a synthetic line, is byte-identical to before', () => {
    const legacy = { id: 'x', status: 'completed', total: 100000, subtotal: 100000, discountAmount: 0, taxAmount: 0, paymentMethod: 'tunai', items: [] }
    const synthetic = { ...legacy, tenders: [{ seq: 1, method: 'tunai', amount: 100000, tendered: 150000, change: 50000, synthetic: true }] }
    const a = aggregate([legacy as unknown as Order], methods)
    expect(aggregate([synthetic as unknown as Order], methods)).toEqual(a)
    expect(a).toMatchObject({ byMethod: { tunai: 100000 }, cashSales: 100000, totalSales: 100000, totalOrders: 1 })
  })
  it('totals still add up across mixed orders', () => {
    const os = [order({ tenders: undefined, paymentMethod: 'qris', total: 100 }), single({ total: 50, tenders: [T(1, 'qris', 50)] }), order({ total: 1251000 })]
    const b = aggregate(os, methods)
    expect(b.totalSales).toBe(100 + 50 + 1251000)
    expect(Object.values(b.byMethod).reduce((a, c) => a + c, 0)).toBe(b.totalSales)
  })
})

describe('queued refund recap keys on the payout method', () => {
  const shift = { id: 'sh1', refundsPaidByMethod: {} } as unknown as components['schemas']['Shift']
  const q = (payload: Record<string, unknown>): QueuedRefund => ({ shiftId: 'sh1', orderId: 'gone', parked: false, payload } as unknown as QueuedRefund)
  it('uses payoutMethod when present, else paymentMethod', () => {
    const base = { orderNumber: 'N', total: 40000, refundAmount: 40000, saleShiftId: 'other', paymentMethod: 'split' }
    expect(refundRecap(shift, [q({ ...base, payoutMethod: 'tunai' })]).crossByMethod).toEqual({ tunai: 40000 })
    expect(refundRecap(shift, [q({ ...base, paymentMethod: 'qris' })]).crossByMethod).toEqual({ qris: 40000 })
  })
})
