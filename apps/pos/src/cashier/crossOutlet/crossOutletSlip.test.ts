import { describe, expect, it } from 'vitest'
import type { CrossOutletRefundResult } from '@mandalika/api'
import { buildCrossOutletSlipData } from './crossOutletSlip'

const result = {
  refundId: 'r1', refundState: 'partial', amount: 60000, replayed: false, saleOutletId: 'x',
  refund: {
    id: 'r1', seq: 1, scope: 'partial', amount: 60000, paymentMethod: 'cash', reason: 'Rusak/cacat', outletId: 'y',
    items: [{ lineNo: 1, quantity: 1, amount: 60000 }],
  },
  order: {
    outletName: 'Lewiliang',
    order: {
      id: 'o1', orderNumber: 'LWB-9',
      items: [
        { productName: 'Parfum A', variantSize: '', lineNo: 0, quantity: 1 },
        { productName: 'Parfum B', variantSize: '', lineNo: 1, quantity: 2 },
      ],
    },
  },
} as unknown as CrossOutletRefundResult

describe('buildCrossOutletSlipData', () => {
  it('is built from the refund row the server kept and names the sale outlet', () => {
    const d = buildCrossOutletSlipData({ result, cashierName: 'Sari', at: new Date('2026-11-26T03:00:00Z') })
    expect(d.orderRef).toBe('LWB-9')
    expect(d.lines).toEqual([{ name: 'Parfum B', qty: 1, amount: 60000 }])
    expect(d.total).toBe(60000)
    expect(d.adjustment).toBeUndefined()
    expect(d.payoutLabel).toBe('Tunai')
    expect(d.reasonLabel).toBe('Rusak/cacat')
    expect(d.originOutlet).toBe('Lewiliang')
  })

  it('adds an adjustment row when the lines do not cover the payout', () => {
    const r = { ...result, refund: { ...result.refund, amount: 59000 } } as CrossOutletRefundResult
    const d = buildCrossOutletSlipData({ result: r, cashierName: 'K', at: new Date() })
    expect(d.adjustment).toEqual({ label: 'Penyesuaian', amount: -1000 })
  })

  it('falls back to the reason the cashier submitted when the server hides it', () => {
    const r = { ...result, refund: { ...result.refund, reason: '' } } as CrossOutletRefundResult
    expect(buildCrossOutletSlipData({ result: r, cashierName: 'K', sentReason: 'Salah ukuran', at: new Date() }).reasonLabel).toBe('Salah ukuran')
    expect(buildCrossOutletSlipData({ result, cashierName: 'K', sentReason: 'Salah ukuran', at: new Date() }).reasonLabel).toBe('Rusak/cacat')
  })
})
