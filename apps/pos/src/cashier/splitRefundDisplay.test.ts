import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { RefundDialog } from './RefundDialog'
import { payoutWarning as rawWarning } from './refundView'
import { aggregate, splitRefundMoves, type PaymentMethodCfg } from './recapAggregate'

type Order = components['schemas']['Order']
const payoutWarning = (...a: Parameters<typeof rawWarning>) => rawWarning(...a)?.replace(/\s/g, ' ') ?? null
const methods: PaymentMethodCfg[] = [
  { id: 'cash', label: 'Tunai', isEnabled: true, isCash: true },
  { id: 'bca', label: 'BCA', isEnabled: true },
  { id: 'bri', label: 'BRI', isEnabled: true },
]
const tender = (seq: number, method: string, amount: number) => ({ seq, method, amount, tendered: amount, synthetic: false })
// BSD-AP0003 and BSD-AP0005 from the Neon shift 58e90a54 (the owner's real case).
const ap3 = {
  id: 'a3', orderNumber: 'BSD-AP0003', status: 'refunded', total: 675000, subtotal: 675000, discountAmount: 0, taxAmount: 0,
  paymentMethod: 'split', items: [], refundedAmount: 675000,
  tenders: [tender(1, 'bca', 600000), tender(2, 'cash', 75000)],
  refunds: [{ seq: 1, amount: 675000, paymentMethod: 'cash', reason: 'x' }],
} as unknown as Order
const ap5 = {
  id: 'a5', orderNumber: 'BSD-AP0005', status: 'refunded', total: 675000, subtotal: 675000, discountAmount: 0, taxAmount: 0,
  paymentMethod: 'split', items: [], refundedAmount: 675000,
  tenders: [tender(1, 'bri', 100000), tender(2, 'bca', 575000)],
  refunds: [{ seq: 1, amount: 675000, paymentMethod: 'bca', reason: 'x' }],
} as unknown as Order

describe('payoutWarning (D-56)', () => {
  const sale = { ...ap3, status: 'completed', refunds: [], refundedAmount: 0 } as unknown as Order
  it('warns when the payout exceeds what the method took, naming both amounts', () => {
    expect(payoutWarning(sale, 'cash', 675000, methods)).toBe('Tunai Rp 675.000 keluar dari laci; tunai yang diterima Rp 75.000.')
  })
  it('is silent when the payout fits the method', () => {
    expect(payoutWarning(sale, 'bca', 600000, methods)).toBeNull()
    expect(payoutWarning(sale, 'cash', 75000, methods)).toBeNull()
  })
  it('counts earlier payouts in the same method (part refunds)', () => {
    const part = { ...sale, status: 'partially_refunded', refunds: [{ seq: 1, amount: 50000, paymentMethod: 'cash', reason: 'x' }] } as unknown as Order
    expect(payoutWarning(part, 'cash', 30000, methods)).toContain('sisa tunai yang diterima Rp 25.000')
    expect(payoutWarning(part, 'cash', 25000, methods)).toBeNull()
  })
  it('keeps bank names as written (BCA, QRIS) and says rekening/EDC', () => {
    expect(payoutWarning(sale, 'bca', 700000, methods)).toBe('BCA Rp 700.000 keluar dari rekening/EDC; BCA yang diterima Rp 600.000.')
  })
  it('warns for a cash chip when the sale took no cash, and ignores non-split orders', () => {
    const noCash = { ...ap5, status: 'completed', refunds: [] } as unknown as Order
    expect(payoutWarning(noCash, 'cash', 10000, methods)).toContain('yang diterima Rp 0')
    const plain = { ...sale, paymentMethod: 'cash', tenders: [tender(1, 'cash', 675000)] } as unknown as Order
    expect(payoutWarning(plain, 'cash', 675000, methods)).toBeNull()
  })
})

describe('splitRefundMoves (recap hint, numbers untouched)', () => {
  it('explains TUNAI -600k / BCA +500k / BRI +100k without changing aggregate', () => {
    const b = aggregate([ap3, ap5], methods)
    expect(b.byMethod).toEqual({ bca: 500000, cash: -600000, bri: 100000 })
    expect(splitRefundMoves([ap3, ap5], methods)).toEqual({
      cash: { paidOut: 600000, redirected: 0 },
      bca: { paidOut: 100000, redirected: 600000 },
      bri: { paidOut: 0, redirected: 100000 },
    })
  })
  it('adds nothing for a same-method full refund or a part refund', () => {
    const same = { ...ap3, refunds: [{ seq: 1, amount: 600000, paymentMethod: 'bca', reason: 'x' }, { seq: 2, amount: 75000, paymentMethod: 'cash', reason: 'x' }] } as unknown as Order
    expect(splitRefundMoves([same, { ...ap5, status: 'partially_refunded' } as unknown as Order], methods)).toEqual({})
  })
})

describe('RefundDialog warning (render)', () => {
  const html = (o: Order) => renderToStaticMarkup(createElement(RefundDialog, {
    order: o, methods, isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn(),
  })).replace(/\s/g, ' ')
  it('shows the warning for the default cash chip of AP0003 (whole-order refund)', () => {
    const sale = { ...ap3, status: 'completed', refunds: [], refundedAmount: 0 } as unknown as Order
    const out = html(sale)
    expect(out).toContain('data-testid="refund-payout-warning"')
    expect(out).toContain('Tunai Rp 675.000 keluar dari laci; tunai yang diterima Rp 75.000.')
  })
  it('keeps an empty status region when the payout fits', () => {
    const sale = { ...ap3, status: 'completed', refunds: [], refundedAmount: 0, tenders: [tender(1, 'cash', 675000), tender(2, 'bca', 1)] } as unknown as Order
    const out = html(sale)
    expect(out).toContain('data-testid="refund-payout-warning"')
    expect(out).not.toContain('keluar dari')
  })
})
