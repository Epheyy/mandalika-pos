import { describe, expect, it } from 'vitest'
import {
  SPLIT_LABEL, defaultPayoutMethod, isSplitOrder, methodLabel, orderMethodText, orderPaymentCsv, paymentLineRows,
  payoutChoices, refundPayoutCsv, refundPayoutText, tenderLineText, tenderWarningTitle,
} from './splitPayment'
import { paymentFilterHint } from '../screens/reports/orderQuery'
import { payloadSummary, tendersLine } from '../screens/syncReview/reviewLabels'

const METHODS = [
  { id: 'tunai', label: 'Tunai', isCash: true, isEnabled: true },
  { id: 'qris', label: 'QRIS', isCash: false, isEnabled: true },
  { id: 'card', label: 'Kartu', isCash: false, isEnabled: true },
]
const line = (seq: number, method: string, amount: number, over: Record<string, unknown> = {}) =>
  ({ seq, method, amount, tendered: amount, change: 0, reference: null, synthetic: false, ...over })
const SPLIT = {
  paymentMethod: 'split',
  tenders: [line(1, 'qris', 751000, { reference: '8812345' }), line(2, 'tunai', 500000, { tendered: 600000, change: 100000 })],
}

describe('row labels (BO5-02)', () => {
  it('shows Tunai/QRIS for raw ids in the split rows, list text and refund payout', () => {
    const o = { paymentMethod: 'Cash', tenders: [line(1, 'Qris', 10), line(2, 'Cash', 5)] }
    expect(paymentLineRows(o).map((r) => r.label)).toEqual(['QRIS', 'Tunai'])
    expect(orderMethodText(o)).toBe('Tunai')
    expect(refundPayoutText({ paymentMethod: 'Cash', payoutSource: null })).toBe('Dikembalikan lewat Tunai')
    expect(orderPaymentCsv({ paymentMethod: 'Cash' })).toBe('Cash') // CSV contract unchanged
  })
})

describe('labels', () => {
  it('names the sentinel Split-Payment and uses the canonical label', () => {
    expect(methodLabel('split', METHODS)).toBe(SPLIT_LABEL)
    expect(methodLabel(' QRIS ', METHODS)).toBe('QRIS')
    expect(methodLabel('bca', METHODS)).toBe('BCA')
    expect(methodLabel('Cash')).toBe('Tunai')
    expect(orderMethodText({ paymentMethod: 'SPLIT' })).toBe('Split-Payment')
    expect(orderMethodText({ paymentMethod: 'qris' }, METHODS)).toBe('QRIS')
    expect(orderMethodText({ paymentMethod: 'Cash' })).toBe('Tunai')
    expect(orderMethodText({ paymentMethod: 'qris' })).toBe('QRIS')
  })
  it('tells split orders from single-method ones like the server', () => {
    expect(isSplitOrder(SPLIT)).toBe(true)
    expect(isSplitOrder({ paymentMethod: 'qris', tenders: [line(1, 'qris', 1), line(2, 'QRIS ', 2)] })).toBe(false)
    expect(isSplitOrder({ paymentMethod: 'qris', tenders: [line(1, 'qris', 1), line(2, 'tunai', 2)] })).toBe(true)
    expect(isSplitOrder({ paymentMethod: 'tunai' })).toBe(false)
    expect(isSplitOrder({ paymentMethod: 'split' })).toBe(true)
  })
  it('titles every tender warning reason and passes unknown ones through', () => {
    expect(tenderWarningTitle('tender_short')).toBe('Uang yang diterima kurang dari total')
    expect(tenderWarningTitle('noncash_overpay')).toBe('Pembayaran non-tunai melebihi total')
    expect(tenderWarningTitle('cash_short')).toBe('Tunai kurang dari total')
    expect(tenderWarningTitle('xyz')).toBe('xyz')
    expect(tenderWarningTitle(null)).toBeUndefined()
  })
})

describe('payment lines and CSV', () => {
  it('lists the lines in seq order with reference and change', () => {
    const rows = paymentLineRows({ tenders: [...SPLIT.tenders].reverse() }, METHODS)
    expect(rows.map((r) => [r.label, r.amount, r.reference, r.change])).toEqual([
      ['QRIS', 751000, '8812345', 0], ['Tunai', 500000, '', 100000],
    ])
  })
  it('writes "QRIS 751.000; Tunai 500.000" for a split order', () => {
    expect(tenderLineText(SPLIT.tenders[0], METHODS)).toBe('QRIS 751.000')
    expect(orderPaymentCsv(SPLIT, METHODS)).toBe('QRIS 751.000; Tunai 500.000')
  })
  it('keeps the raw method id for single-method and line-less orders', () => {
    expect(orderPaymentCsv({ paymentMethod: 'qris', tenders: [line(1, 'qris', 5, { synthetic: true })] }, METHODS)).toBe('qris')
    expect(orderPaymentCsv({ paymentMethod: 'tunai' }, METHODS)).toBe('tunai')
    expect(orderPaymentCsv({ paymentMethod: 'split' }, METHODS)).toBe('split')
  })
})

describe('refund payout text', () => {
  it('says where the money went and why, in plain Indonesian', () => {
    expect(refundPayoutText({ paymentMethod: 'tunai', payoutSource: 'chosen' }, METHODS)).toBe('Dikembalikan lewat Tunai (dipilih saat refund)')
    expect(refundPayoutText({ paymentMethod: 'qris', payoutSource: 'sale' }, METHODS)).toBe('Dikembalikan lewat QRIS (sama dengan metode penjualan)')
    expect(refundPayoutText({ paymentMethod: 'tunai', payoutSource: 'default' }, METHODS)).toContain('otomatis')
  })
  it('shows the method alone for a refund written before C6a', () => {
    expect(refundPayoutText({ paymentMethod: 'tunai', payoutSource: null }, METHODS)).toBe('Dikembalikan lewat Tunai')
    expect(refundPayoutText({ paymentMethod: '', payoutSource: 'sale' }, METHODS)).toBe('')
  })
  it('lists each distinct payout method once for the orders CSV', () => {
    const refunds = [{ paymentMethod: 'tunai' }, { paymentMethod: 'Tunai' }, { paymentMethod: 'qris' }] as never
    expect(refundPayoutCsv({ refunds }, METHODS)).toBe('Tunai; QRIS')
    expect(refundPayoutCsv({}, METHODS)).toBe('')
  })
})

// Parity with Go's defaultPayoutMethod (service/refund_payout.go) and the SQL order_default_payout_method.
describe('D-56 default payout (parity with the server rule)', () => {
  it('takes the cash line when the sale had cash, even if smaller', () => {
    expect(defaultPayoutMethod({ tenders: [line(1, 'qris', 900000), line(2, 'tunai', 100000)] }, METHODS)).toBe('tunai')
  })
  it('takes the lowest-seq cash line when several are cash', () => {
    const methods = [...METHODS, { id: 'kas2', label: 'Kas 2', isCash: true }]
    expect(defaultPayoutMethod({ tenders: [line(1, 'qris', 1), line(2, 'kas2', 2), line(3, 'tunai', 3)] }, methods)).toBe('kas2')
  })
  it('takes the largest line when there is no cash', () => {
    expect(defaultPayoutMethod({ tenders: [line(1, 'qris', 300000), line(2, 'card', 700000)] }, METHODS)).toBe('card')
  })
  it('breaks a tie by lowest seq', () => {
    expect(defaultPayoutMethod({ tenders: [line(2, 'card', 500000), line(1, 'qris', 500000)] }, METHODS)).toBe('qris')
  })
  it('honours an explicit isCash=false on tunai, like IsCashMethod', () => {
    const methods = [{ id: 'tunai', label: 'Tunai', isCash: false }, { id: 'qris', label: 'QRIS', isCash: false }]
    expect(defaultPayoutMethod({ tenders: [line(1, 'tunai', 100), line(2, 'qris', 900)] }, methods)).toBe('qris')
  })
  it('is blank without lines', () => {
    expect(defaultPayoutMethod({ tenders: [] }, METHODS)).toBe('')
  })
})

describe('payout chips', () => {
  it('offers the sale methods in line order and preselects the default', () => {
    const c = payoutChoices(SPLIT, METHODS)
    expect(c.options).toEqual([{ id: 'qris', label: 'QRIS' }, { id: 'tunai', label: 'Tunai' }])
    expect(c.defaultId).toBe('tunai')
  })
  it('adds the configured enabled cash method when the sale had none', () => {
    const c = payoutChoices({ tenders: [line(1, 'qris', 300), line(2, 'card', 700)] }, METHODS)
    expect(c.options.map((o) => o.id)).toEqual(['qris', 'card', 'tunai'])
    expect(c.defaultId).toBe('card')
  })
  it('does not add a disabled cash method', () => {
    const methods = [{ id: 'tunai', label: 'Tunai', isCash: true, isEnabled: false }, ...METHODS.slice(1)]
    expect(payoutChoices({ tenders: [line(1, 'qris', 3), line(2, 'card', 7)] }, methods).options.map((o) => o.id)).toEqual(['qris', 'card'])
  })
})

describe('filter hint and sync review', () => {
  it('explains the method and Split-Payment filters, and is silent without one', () => {
    expect(paymentFilterHint('', '')).toBe('')
    expect(paymentFilterHint('qris', 'QRIS')).toContain('berisi metode QRIS')
    expect(paymentFilterHint('split', 'Split-Payment')).toContain('Split-Payment')
  })
  it('summarises the tender lines and payout method of queued payloads', () => {
    expect(tendersLine([{ method: 'qris', amount: 751000 }, { method: 'tunai', amount: 500000 }])).toMatch(/^QRIS .*751\.000 \+ Tunai .*500\.000$/)
    expect(tendersLine(undefined)).toBe('')
    const sale = payloadSummary('order', { orderNumber: 'A', paymentMethod: 'split', amountPaid: 1, tenders: [{ method: 'qris', amount: 1 }] })
    expect(sale.find(([k]) => k === 'Metode')?.[1]).toBe('Split-Payment')
    expect(sale.some(([k]) => k === 'Pembayaran')).toBe(true)
    const refund = payloadSummary('refund', { orderNumber: 'A', payoutMethod: 'tunai' })
    expect(refund.find(([k]) => k === 'Dikembalikan lewat')?.[1]).toBe('Tunai')
  })
})
