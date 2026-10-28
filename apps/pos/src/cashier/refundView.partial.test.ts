import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import {
  REFUND_CHANGED, REFUND_DONE, REFUND_QUEUED, REFUND_USE_HISTORY, partialGateFor, planRefundSubmit, prepareRefund, refundAvailability, refundDetail, refundPartialNote,
  type RefundAvailabilityInput, type RefundPayload,
} from './refundView'

type Order = components['schemas']['Order']

const line = (lineNo: number | undefined, qty: number, net: number | undefined, extra: Record<string, unknown> = {}) => ({
  productId: `p${lineNo}`, productName: `P${lineNo}`, variantSize: '', price: qty ? Math.round((net ?? 0) / qty) : 0, quantity: qty, subtotal: net ?? 0,
  ...(lineNo === undefined ? {} : { lineNo }), ...(net === undefined ? {} : { netAmount: net }), ...extra,
})
const order = (items: unknown[], extra: Partial<Order> = {}): Order =>
  ({ id: 'o1', orderNumber: 'BSD-7', status: 'completed', total: 150000, paymentMethod: 'cash', shiftId: 'sh-sale', createdAt: '', items, ...extra }) as unknown as Order
const gate = (o: Order, over: Partial<RefundAvailabilityInput> = {}): RefundAvailabilityInput => ({
  order: o, canRefund: true, hasOpenShift: true, queuedOrderIds: new Set(), ...over,
})

describe('gate: partially refunded orders (C4b)', () => {
  const two = [line(0, 2, 100000), line(1, 1, 50000)]

  it('a completed order is allowed with no note', () => {
    expect(refundAvailability(gate(order(two)))).toEqual({ kind: 'allowed' })
  })

  it('a partially_refunded order keeps the button and shows "Sebagian direfund · sisa Rp X"', () => {
    const o = order(two, { status: 'partially_refunded', refundedAmount: 50000 })
    const a = refundAvailability(gate(o, { partial: partialGateFor(o) }))
    expect(a.kind).toBe('allowed')
    expect(a.kind === 'allowed' && a.note).toBe(refundPartialNote(100000))
    expect(refundPartialNote(100000)).toMatch(/^Sebagian direfund · sisa Rp\s100\.000$/)
  })

  it('a stale "completed" row that this tablet already part-refunded still shows the chip', () => {
    const o = order(two)
    const partial = partialGateFor(o, { qtyByLine: new Map([[0, 1]]), amount: 50000 })
    expect(partial).toEqual({ any: true, exhausted: false, remaining: 100000 })
    const a = refundAvailability(gate(o, { partial }))
    expect(a.kind === 'allowed' && a.note).toBeTruthy()
  })

  it('every unit refunded on this tablet blocks with "Sudah direfund", whatever the stale row says', () => {
    const o = order(two)
    const partial = partialGateFor(o, { qtyByLine: new Map([[0, 2], [1, 1]]), amount: 150000 })
    expect(partial.exhausted).toBe(true)
    expect(refundAvailability(gate(o, { partial }))).toEqual({ kind: 'blocked', reason: REFUND_DONE })
  })

  it('a refunded or cancelled order stays hidden', () => {
    expect(refundAvailability(gate(order(two, { status: 'refunded' })))).toEqual({ kind: 'hidden' })
    expect(refundAvailability(gate(order(two, { status: 'cancelled' })))).toEqual({ kind: 'hidden' })
  })

  it('D-44: a refund queued on this tablet blocks a second one, even for a part-refunded order', () => {
    const o = order(two, { status: 'partially_refunded', refundedAmount: 50000 })
    const a = refundAvailability(gate(o, { partial: partialGateFor(o), queuedOrderIds: new Set(['o1']) }))
    expect(a).toEqual({ kind: 'blocked', reason: REFUND_QUEUED })
  })

  it('the whole-order "done" memory still blocks', () => {
    expect(refundAvailability(gate(order(two), { syncedRefundOrderIds: new Set(['o1']) }))).toEqual({ kind: 'blocked', reason: REFUND_DONE })
  })

  it('an order without line data has no partial state (whole-order only)', () => {
    expect(partialGateFor(order([line(undefined, 1, undefined)]))).toEqual({ any: false, exhausted: false, remaining: null })
  })
})

describe('payload shape', () => {
  const base = { order: order([]), reason: 'Rusak/cacat', canRefund: true, shiftId: 'sh-open' }

  it('a per-line refund carries items, refundAmount, reasonCode and a snapshot total equal to what is paid out', () => {
    const r = prepareRefund({ ...base, reasonCode: 'rusak_cacat', lines: { items: [{ lineNo: 1, quantity: 1 }], amount: 50000 } })
    expect(r.ok && r.payload).toEqual({
      orderId: 'o1', reason: 'Rusak/cacat', reasonCode: 'rusak_cacat', items: [{ lineNo: 1, quantity: 1 }], refundAmount: 50000,
      orderNumber: 'BSD-7', total: 50000, paymentMethod: 'cash', saleShiftId: 'sh-sale',
    })
  })

  it('a whole-order refund keeps the legacy shape: no items and no refundAmount key at all (never null)', () => {
    const r = prepareRefund({ ...base })
    const p = (r.ok ? r.payload : null) as RefundPayload
    expect(Object.keys(p)).not.toContain('items')
    expect(Object.keys(p)).not.toContain('refundAmount')
    expect(JSON.stringify(p)).not.toContain('null,')
    expect(p.total).toBe(150000)
  })

  it('refuses an empty pick or a fractional / negative amount instead of queueing it', () => {
    expect(prepareRefund({ ...base, lines: { items: [], amount: 0 } }).ok).toBe(false)
    expect(prepareRefund({ ...base, lines: { items: [{ lineNo: 0, quantity: 1 }], amount: 10.5 } }).ok).toBe(false)
    expect(prepareRefund({ ...base, lines: { items: [{ lineNo: 0, quantity: 1 }], amount: -1 } }).ok).toBe(false)
  })

  it('a local sale names itself by uuid with an empty server id', () => {
    const r = prepareRefund({ ...base, sale: { orderUuid: 'u-1' }, lines: { items: [{ lineNo: 0, quantity: 1 }], amount: 1 } })
    expect(r.ok && r.payload.orderId).toBe('')
    expect(r.ok && r.payload.saleOrderUuid).toBe('u-1')
  })

  it('the review row shows the paid-out amount and the unit count', () => {
    const r = prepareRefund({ ...base, lines: { items: [{ lineNo: 0, quantity: 2 }, { lineNo: 1, quantity: 1 }], amount: 75000 } })
    expect(r.ok && refundDetail(r.payload as unknown as Record<string, unknown>)).toMatch(/^BSD-7 · Rp\s75\.000 · Tunai · 3 barang$/)
  })
})

describe('planRefundSubmit re-derives the refund from the order and the pick', () => {
  const o = order([line(0, 3, 100000), line(1, 1, 50000)])
  const args = { refundOrder: o, orderId: 'o1', reason: 'Salah varian', reasonCode: 'salah_varian', canRefund: true, shiftId: 'sh-open' }

  it('derives items and the net amount from the picked units, ignoring anything else', () => {
    const plan = planRefundSubmit({ ...args, selection: { 0: 1 } })
    expect(plan.kind === 'enqueue' && plan.payload.items).toEqual([{ lineNo: 0, quantity: 1 }])
    expect(plan.kind === 'enqueue' && plan.payload.refundAmount).toBe(33333)
  })

  it('the same inputs always give the same body (a retry never changes what a key was issued for)', () => {
    const a = planRefundSubmit({ ...args, selection: { 0: 2, 1: 1 } })
    const b = planRefundSubmit({ ...args, selection: { 1: 1, 0: 2 } })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the last refund settles the remainder after earlier refunds were paid', () => {
    const plan = planRefundSubmit({ ...args, selection: { 0: 1, 1: 1 }, cache: { qtyByLine: new Map([[0, 2]]), amount: 70000 } })
    expect(plan.kind === 'enqueue' && plan.payload.refundAmount).toBe(80000)
  })

  it('refuses a pick that no longer fits (the order changed under the dialog) rather than trimming it', () => {
    const plan = planRefundSubmit({ ...args, selection: { 0: 3 }, cache: { qtyByLine: new Map([[0, 2]]) } })
    expect(plan).toEqual({ kind: 'error', message: REFUND_CHANGED })
  })

  it('refuses an empty pick, a missing reason and a mismatched dialog order', () => {
    expect(planRefundSubmit({ ...args, selection: {} }).kind).toBe('error')
    expect(planRefundSubmit({ ...args, reason: '  ', selection: { 0: 1 } }).kind).toBe('error')
    expect(planRefundSubmit({ ...args, orderId: 'other', selection: { 0: 1 } }).kind).toBe('error')
  })

  it('an order without line data is refunded whole, in the legacy shape, with the reason slug', () => {
    const legacy = order([line(undefined, 1, undefined)])
    const plan = planRefundSubmit({ ...args, refundOrder: legacy, selection: { 0: 1 } })
    expect(plan.kind === 'enqueue' && 'items' in plan.payload).toBe(false)
    expect(plan.kind === 'enqueue' && plan.payload.reasonCode).toBe('salah_varian')
    expect(plan.kind === 'enqueue' && plan.payload.total).toBe(150000)
  })
})

describe('refundSummaries (history shows which lines came back)', () => {
  it('names the refunded lines from the order and orders refunds by seq', async () => {
    const { refundSummaries } = await import('./refundView')
    const o = order([line(0, 2, 100000), line(1, 1, 50000)], {
      refunds: [
        { id: 'r2', seq: 2, scope: 'full', amount: 100000, computedAmount: 100000, paymentMethod: 'cash', reason: 'Salah varian', refundedAt: '', items: [{ orderItemId: 'x', lineNo: 0, quantity: 1, amount: 50000 }, { orderItemId: 'y', lineNo: 9, quantity: 1, amount: 50000 }] },
        { id: 'r1', seq: 1, scope: 'partial', amount: 50000, computedAmount: 50000, paymentMethod: 'cash', reason: 'Rusak/cacat', items: [{ orderItemId: 'z', lineNo: 1, quantity: 1, amount: 50000 }] },
      ],
    } as never)
    const s = refundSummaries(o)
    expect(s.map((r) => r.seq)).toEqual([1, 2])
    expect(s[0].lines).toEqual([{ name: 'P1', quantity: 1, amount: 50000 }])
    expect(s[1].lines.map((l) => l.name)).toEqual(['P0', 'Baris 10'])
  })
  it('is empty for an order without refunds', async () => {
    const { refundSummaries } = await import('./refundView')
    expect(refundSummaries(order([line(0, 1, 10)]))).toEqual([])
  })
})

describe('C4b review fixes: a struk without line data that this tablet already part-refunded', () => {
  const noLines = order([line(undefined, 1, undefined)])
  const cache = { qtyByLine: new Map([[0, 1]]), amount: 50000 }

  it('blocks a whole-order refund (it would pay the part already refunded twice) and points to Riwayat', () => {
    const partial = partialGateFor(noLines, cache)
    expect(partial).toEqual({ any: true, exhausted: false, remaining: null, wholeBlocked: true })
    expect(refundAvailability(gate(noLines, { partial }))).toEqual({ kind: 'blocked', reason: REFUND_USE_HISTORY })
  })

  it('planRefundSubmit refuses it too, even if the button were somehow reachable', () => {
    const plan = planRefundSubmit({ refundOrder: noLines, orderId: 'o1', reason: 'x', reasonCode: 'lainnya', cache, canRefund: true, shiftId: 'sh' })
    expect(plan).toEqual({ kind: 'error', message: REFUND_USE_HISTORY })
  })

  it('without any earlier per-line refund the whole-order refund stays available', () => {
    expect(refundAvailability(gate(noLines, { partial: partialGateFor(noLines, {}) }))).toEqual({ kind: 'allowed' })
  })
})
