import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { buildRefundSlipData, printRefundSlipSafely } from './refundSlipData'
import { planRefundSubmit } from './refundView'

type Order = components['schemas']['Order']

const line = (lineNo: number, name: string, qty: number, net: number, extra: Record<string, unknown> = {}) => ({
  productId: `p${lineNo}`, productName: name, variantSize: '', price: Math.round(net / qty), quantity: qty, subtotal: net, lineNo, netAmount: net, ...extra,
})
const order = (items: unknown[], extra: Partial<Order> = {}): Order =>
  ({ id: 'o1', orderNumber: 'BSD-7', status: 'completed', total: 300000, paymentMethod: 'cash', shiftId: 'sh', createdAt: '', items, ...extra }) as unknown as Order
const AT = new Date('2026-05-29T03:04:00Z')
const plan = (o: Order, selection: Record<number, number>, extra: Record<string, unknown> = {}) => {
  const p = planRefundSubmit({ refundOrder: o, orderId: 'o1', reason: 'Rusak/cacat', reasonCode: 'rusak_cacat', selection, canRefund: true, shiftId: 'sh', ...extra })
  if (p.kind !== 'enqueue') throw new Error(p.message)
  return p.payload
}

describe('buildRefundSlipData', () => {
  it('a 2-line partial refund lists only the selected lines and the refund amount', () => {
    const o = order([line(0, 'Parfum Bunga', 2, 200000), line(1, 'Parfum Melati', 1, 100000)])
    const payload = plan(o, { 0: 1 })
    const d = buildRefundSlipData({ order: o, payload, cashierName: 'Sari', at: AT })
    expect(d.lines).toEqual([{ name: 'Parfum Bunga', qty: 1, amount: 100000 }])
    expect(d.total).toBe(100000)
    expect(d.orderRef).toBe('BSD-7')
    expect(d.reasonLabel).toBe('Rusak/cacat')
    expect(d.cashierName).toBe('Sari')
    expect(d.payoutLabel).toBe('Tunai')
  })

  it('carries the sale outlet as originOutlet only when given (A18)', () => {
    const o = order([line(0, 'A', 1, 100000)])
    const payload = plan(o, { 0: 1 })
    expect(buildRefundSlipData({ order: o, payload, cashierName: 'K', at: AT, originOutlet: 'Lewiliang' }).originOutlet).toBe('Lewiliang')
    expect('originOutlet' in buildRefundSlipData({ order: o, payload, cashierName: 'K', at: AT })).toBe(false)
  })

  it('lines + adjustment always add up to the payout, and no line is bent to make it so', () => {
    const o = order([line(0, 'A', 3, 100000), line(1, 'B', 1, 50)])
    const d = buildRefundSlipData({ order: o, payload: plan(o, { 0: 3, 1: 1 }), cashierName: 'K', at: AT })
    expect(d.lines.reduce((n, l) => n + l.amount, 0) + (d.adjustment?.amount ?? 0)).toBe(d.total)
    // A legacy 2-line order whose order discount is bigger than the last line: the lines keep their own subtotals.
    const sub = (name: string, subtotal: number) => ({ productId: name, productName: name, variantSize: '', price: subtotal, quantity: 1, subtotal })
    const legacy = order([sub('A', 100000), sub('B', 20000)], { total: 70000 })
    const w = buildRefundSlipData({ order: legacy, payload: plan(legacy, {}), cashierName: 'K', at: AT })
    expect(w.total).toBe(70000)
    expect(w.lines.map((l) => l.amount)).toEqual([100000, 20000])
    expect(w.adjustment).toEqual({ label: 'Penyesuaian', amount: -50000 })
    expect(w.lines.reduce((n, l) => n + l.amount, 0) + w.adjustment!.amount).toBe(70000)
    // Lines that already add up carry no adjustment row.
    const exact = order([sub('A', 100000)], { total: 100000 })
    expect(buildRefundSlipData({ order: exact, payload: plan(exact, {}), cashierName: 'K', at: AT })).not.toHaveProperty('adjustment')
  })

  it('earlier refunds from the cache set a line share, like the queued amount', () => {
    const o = order([line(0, 'A', 3, 100000)])
    const cache = { qtyByLine: new Map([[0, 1]]), amount: 33333 }
    const payload = plan(o, { 0: 1 }, { cache })
    const d = buildRefundSlipData({ order: o, payload, cache, cashierName: 'K', at: AT })
    expect(d.total).toBe(payload.total)
    expect(d.lines[0]!.amount).toBe(d.total)
  })

  it('split order uses the chosen payout label', () => {
    const o = order([line(0, 'A', 1, 300000)], {
      paymentMethod: 'split',
      tenders: [{ seq: 0, method: 'cash', amount: 100000 }, { seq: 1, method: 'ovo-toko', amount: 200000 }] as unknown as Order['tenders'],
    })
    const payload = plan(o, { 0: 1 }, { payoutMethod: 'ovo-toko' })
    const d = buildRefundSlipData({ order: o, payload, methods: [{ id: 'ovo-toko', label: 'OVO Toko' }, { id: 'cash', label: 'Tunai', isCash: true }], cashierName: 'K', at: AT })
    expect(d.payoutLabel).toBe('OVO Toko')
  })

  it('carries the outlet only when given', () => {
    const o = order([line(0, 'A', 1, 300000)])
    const payload = plan(o, { 0: 1 })
    expect(buildRefundSlipData({ order: o, payload, cashierName: 'K', at: AT })).not.toHaveProperty('outlet')
    expect(buildRefundSlipData({ order: o, payload, cashierName: 'K', at: AT, outlet: { name: 'BSD' } }).outlet).toEqual({ name: 'BSD' })
  })
})

describe('printRefundSlipSafely', () => {
  const base = () => ({
    isPaired: true, build: vi.fn(() => ({}) as never), print: vi.fn(async () => {}), orderRef: 'BSD-7',
    onFailure: vi.fn(), report: vi.fn(), outletName: 'BSD',
  })

  it('a print failure after a refund reports refund_slip, toasts, and does not throw', async () => {
    const i = base()
    i.print.mockRejectedValue(new Error('Gagal mencetak: printer tidak menjawab.'))
    await expect(printRefundSlipSafely(i)).resolves.toBeUndefined()
    expect(i.report).toHaveBeenCalledWith(expect.objectContaining({ source: 'print', kind: 'refund_slip', outletName: 'BSD' }))
    expect(i.onFailure).toHaveBeenCalledWith(expect.stringContaining('Refund tersimpan'))
  })

  it('a data-building failure is contained the same way', async () => {
    const i = base()
    i.build.mockImplementation(() => { throw new Error('bad data') })
    await expect(printRefundSlipSafely(i)).resolves.toBeUndefined()
    expect(i.print).not.toHaveBeenCalled()
    expect(i.report).toHaveBeenCalledTimes(1)
  })

  it('prints nothing without a paired printer, and a throwing reporter still cannot fail the refund', async () => {
    const none = base()
    await printRefundSlipSafely({ ...none, isPaired: false })
    expect(none.build).not.toHaveBeenCalled()
    const i = base()
    i.print.mockRejectedValue(new Error('x'))
    i.report.mockImplementation(() => { throw new Error('report down') })
    await expect(printRefundSlipSafely(i)).resolves.toBeUndefined()
  })
})
