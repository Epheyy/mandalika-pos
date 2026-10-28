import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import {
  EMPTY_SELECTION, buildReason, buildRefundBasis, isExhausted, lineLockReason, refundAmountFor, remainingAmount, selectAll,
  selectionToItems, setLineQty, toggleLine, type RefundBasis, type RefundLine,
} from './refundSelection'

type Order = components['schemas']['Order']
type Lines = Extract<RefundBasis, { kind: 'lines' }>

const item = (lineNo: number | undefined, name: string, qty: number, net: number | undefined, extra: Record<string, unknown> = {}) => ({
  productId: `p${lineNo}`, productName: name, variantSize: '', price: qty ? Math.round((net ?? 0) / qty) : 0, quantity: qty,
  subtotal: net ?? 0, ...(lineNo === undefined ? {} : { lineNo }), ...(net === undefined ? {} : { netAmount: net }), ...extra,
})
const order = (items: unknown[], extra: Partial<Order> = {}): Order =>
  ({ id: 'o1', orderNumber: 'BSD-1', status: 'completed', total: 0, paymentMethod: 'cash', createdAt: '', items, ...extra }) as unknown as Order
const lines = (o: Order, cache = {}) => {
  const b = buildRefundBasis(o, cache)
  if (b.kind !== 'lines') throw new Error('expected a per-line basis')
  return b as Lines
}

describe('buildRefundBasis', () => {
  it('per-line when every line has lineNo and a whole-rupiah net', () => {
    const b = lines(order([item(0, 'A', 2, 100000), item(1, 'B', 1, 50000)], { total: 150000 }))
    expect(b.lines.map((l) => [l.lineNo, l.soldQty, l.remainingQty, l.net])).toEqual([[0, 2, 2, 100000], [1, 1, 1, 50000]])
    expect(b.priorAmount).toBe(0)
  })

  it('whole-order only for a pre-C4a order (any line without lineNo or net) — D-33', () => {
    expect(buildRefundBasis(order([item(undefined, 'A', 1, undefined)], { total: 1000 })).kind).toBe('whole')
    expect(buildRefundBasis(order([item(0, 'A', 1, 10), item(undefined, 'B', 1, undefined)])).kind).toBe('whole')
    expect(buildRefundBasis(order([item(0, 'A', 1, 10.5)])).kind).toBe('whole')
    expect(buildRefundBasis(order([])).kind).toBe('whole')
  })

  it('subtracts what the server already refunded, and the larger of server and tablet cache wins', () => {
    const o = order([item(0, 'A', 3, 90000, { refundedQty: 1 })], { total: 90000, refundedAmount: 30000 })
    expect(lines(o).lines[0].remainingQty).toBe(2)
    expect(lines(o, { qtyByLine: new Map([[0, 2]]), amount: 60000 }).lines[0].remainingQty).toBe(1)
    expect(lines(o, { qtyByLine: new Map([[0, 0]]), amount: 0 }).lines[0].remainingQty).toBe(2)
    expect(lines(o, { qtyByLine: new Map([[0, 9]]) }).lines[0].remainingQty).toBe(0)
  })

  it('lists the giveaway bag but keeps it out of the lines (D-41)', () => {
    const o = order([item(0, 'A', 1, 100), item(1, 'Tas', 1, 0, { isGiveaway: true, lineNo: undefined })], { total: 100 })
    const b = lines(o)
    expect(b.giveaway).toBe('Tas')
    expect(b.lines.map((l) => l.lineNo)).toEqual([0])
  })
})

describe('selection rules', () => {
  const o = order([
    item(0, 'A', 3, 90000), item(1, 'B', 1, 50000),
    item(2, 'Paket paid', 1, 100000, { refundGroup: 'bundle:b:1' }), item(3, 'Paket gratis', 1, 0, { refundGroup: 'bundle:b:1', isReward: true }),
    item(4, 'Hadiah poin', 1, 0, { isReward: true }),
  ], { total: 240000 })
  const b = lines(o)

  it('clamps the stepper to 0..remaining and ignores NaN', () => {
    expect(setLineQty(b.lines, EMPTY_SELECTION, 0, 99)[0]).toBe(3)
    expect(setLineQty(b.lines, { 0: 2 }, 0, 0)[0]).toBeUndefined()
    expect(setLineQty(b.lines, EMPTY_SELECTION, 0, -4)[0]).toBeUndefined()
    expect(setLineQty(b.lines, EMPTY_SELECTION, 0, Number.NaN)[0]).toBeUndefined()
    expect(setLineQty(b.lines, EMPTY_SELECTION, 0, 1.9)[0]).toBe(1)
  })

  it('a promo group is all-or-nothing: picking one member picks the other, clearing one clears both (D-34)', () => {
    const on = toggleLine(b.lines, EMPTY_SELECTION, 2)
    expect(on[2]).toBe(1)
    expect(on[3]).toBe(1)
    const off = toggleLine(b.lines, on, 3)
    expect(off[2]).toBeUndefined()
    expect(off[3]).toBeUndefined()
  })

  it('a loyalty reward line (Rp0, no group) is selectable alone (D-35)', () => {
    const sel = toggleLine(b.lines, EMPTY_SELECTION, 4)
    expect(selectionToItems(b.lines, sel)).toEqual([{ lineNo: 4, quantity: 1 }])
  })

  it('a line or group that is already refunded cannot be picked', () => {
    const done = lines(order([item(0, 'A', 1, 100, { refundedQty: 1 }), item(1, 'G1', 1, 50, { refundGroup: 'g', refundedQty: 1 }), item(2, 'G2', 1, 0, { refundGroup: 'g' })], { total: 150 }))
    expect(lineLockReason(done.lines[0], done.lines)).not.toBeNull()
    expect(lineLockReason(done.lines[2], done.lines)).not.toBeNull()
    expect(setLineQty(done.lines, EMPTY_SELECTION, 0, 1)).toEqual({})
    expect(setLineQty(done.lines, EMPTY_SELECTION, 2, 1)).toEqual({})
  })

  it('selectAll picks every selectable line at its remaining and skips the locked ones', () => {
    const sel = selectAll(b.lines)
    expect(selectionToItems(b.lines, sel).map((i) => [i.lineNo, i.quantity])).toEqual([[0, 3], [1, 1], [2, 1], [3, 1], [4, 1]])
  })

  it('selectionToItems drops over-cap entries and stale lineNos (never sends them)', () => {
    expect(selectionToItems(b.lines, { 0: 99, 77: 1, 1: 1 } as never)).toEqual([{ lineNo: 1, quantity: 1 }])
    expect(selectionToItems(b.lines, EMPTY_SELECTION)).toEqual([])
  })
})

describe('refund amount (cum differences, last refund settles the remainder)', () => {
  it('prices a partial refund at the floored net share', () => {
    const b = lines(order([item(0, 'A', 3, 100000)], { total: 100000 }))
    expect(refundAmountFor(b, { 0: 1 })).toEqual({ amount: 33333, settlesRemainder: false })
    expect(refundAmountFor(b, { 0: 2 })).toEqual({ amount: 66666, settlesRemainder: false })
  })

  it('refunds across three one-unit refunds add up to the total exactly', () => {
    const base = order([item(0, 'A', 3, 100000)], { total: 100000 })
    let paid = 0
    let refunded = 0
    for (let step = 0; step < 3; step++) {
      const b = lines({ ...base, refundedAmount: paid } as Order, { qtyByLine: new Map([[0, refunded]]), amount: paid })
      const r = refundAmountFor(b, { 0: 1 })
      paid += r.amount
      refunded += 1
      expect(r.settlesRemainder).toBe(step === 2)
    }
    expect(paid).toBe(100000)
  })

  it('the last refund pays total minus what was already paid, absorbing an earlier claimed amount', () => {
    // 2 of 3 units were refunded earlier and the cashier paid out 70000 (claimed, not the computed 66666).
    const b = lines(order([item(0, 'A', 3, 100000, { refundedQty: 2 })], { total: 100000, refundedAmount: 70000 }))
    expect(refundAmountFor(b, { 0: 1 })).toEqual({ amount: 30000, settlesRemainder: true })
  })

  it('a Rp0 reward line alone refunds Rp0 and does not settle while paid lines remain', () => {
    const b = lines(order([item(0, 'A', 1, 100000), item(1, 'Hadiah', 1, 0, { isReward: true })], { total: 100000 }))
    expect(refundAmountFor(b, { 1: 1 })).toEqual({ amount: 0, settlesRemainder: false })
  })

  it('nothing picked is Rp0 and never settles', () => {
    const b = lines(order([item(0, 'A', 1, 100)], { total: 100 }))
    expect(refundAmountFor(b, EMPTY_SELECTION)).toEqual({ amount: 0, settlesRemainder: false })
  })

  it('never goes negative when earlier refunds already paid more than the total', () => {
    const b = lines(order([item(0, 'A', 2, 100, { refundedQty: 1 })], { total: 100, refundedAmount: 130 }))
    expect(refundAmountFor(b, { 0: 1 }).amount).toBe(0)
  })

  it('remainingAmount and isExhausted follow the order row', () => {
    const b = lines(order([item(0, 'A', 2, 100, { refundedQty: 1 })], { total: 100, refundedAmount: 50 }))
    expect(remainingAmount(b)).toBe(50)
    expect(isExhausted(b)).toBe(false)
    expect(isExhausted(lines(order([item(0, 'A', 1, 100, { refundedQty: 1 })], { total: 100, refundedAmount: 100 })))).toBe(true)
    expect(isExhausted(buildRefundBasis(order([])))).toBe(false)
  })
})

describe('reasons (D-43)', () => {
  it('a preset sends its label and slug', () => {
    expect(buildReason('rusak_cacat', '')).toEqual({ ok: true, reason: 'Rusak/cacat', reasonCode: 'rusak_cacat' })
  })
  it('"Lainnya" needs text and sends it trimmed', () => {
    expect(buildReason('lainnya', '  ')).toEqual({ ok: false, error: 'Alasan refund wajib diisi' })
    expect(buildReason('lainnya', ' bau aneh ')).toEqual({ ok: true, reason: 'bau aneh', reasonCode: 'lainnya' })
  })
  it('no choice is an error', () => {
    expect(buildReason(null, '').ok).toBe(false)
    expect(buildReason('hack', '').ok).toBe(false)
  })
})

describe('RefundLine shape', () => {
  it('marks Rp0 lines as rewards for display', () => {
    const l = lines(order([item(0, 'G', 1, 0)], { total: 0 })).lines[0] as RefundLine
    expect(l.isReward).toBe(true)
  })
})

describe('C4b review fixes', () => {
  it('the last refund never pays more than the picked units are worth, even when the prior payout is understated', () => {
    // Two units were refunded earlier (33333 + 33333) but only one earlier payout reached this tablet's view
    // (max of server row and cache, not their union), so prior is 33333.
    const b = lines(order([item(0, 'A', 3, 100000, { refundedQty: 2 })], { total: 100000, refundedAmount: 33333 }))
    expect(refundAmountFor(b, { 0: 1 })).toEqual({ amount: 33334, settlesRemainder: true })
  })

  it('the last refund still pays less when earlier refunds were paid generously', () => {
    const b = lines(order([item(0, 'A', 3, 100000, { refundedQty: 2 })], { total: 100000, refundedAmount: 70000 }))
    expect(refundAmountFor(b, { 0: 1 })).toEqual({ amount: 30000, settlesRemainder: true })
  })

  it('cacheHasRefunds sees units or money', async () => {
    const { cacheHasRefunds } = await import('./refundSelection')
    expect(cacheHasRefunds(undefined)).toBe(false)
    expect(cacheHasRefunds({})).toBe(false)
    expect(cacheHasRefunds({ qtyByLine: new Map([[0, 0]]), amount: 0 })).toBe(false)
    expect(cacheHasRefunds({ qtyByLine: new Map([[2, 1]]) })).toBe(true)
    expect(cacheHasRefunds({ amount: 10 })).toBe(true)
  })
})
