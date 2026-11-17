import { describe, expect, it } from 'vitest'
import { buildReceipt, type ReceiptData } from '@mandalika/printer'
import { receiptBytes } from '@mandalika/printer/render'
import { receiptOutlet, receiptPoints, resolveReceiptLayout } from './receiptLayout'

const receipt = { headerText: 'TOKO', footerText: 'Terima kasih', showTax: true, showCashier: true }
const data: ReceiptData = {
  orderRef: 'T1', pending: false, dateTime: new Date('2026-05-29T03:04:00Z'),
  lines: [{ name: 'Parfum', qty: 1, unitPrice: 1000, amount: 1000 }], subtotal: 1000, discountAmount: 0, taxAmount: 0, total: 1000,
  paymentLabel: 'Tunai', amountPaid: 1000, change: 0, customerName: null, customerPhone: null, cashierName: 'Kasir',
}
const good = {
  id: 'a', version: 2, paperWidth: 58 as const,
  blocks: [
    { id: 'i', type: 'items' as const, enabled: true },
    { id: 'o', type: 'totals' as const, enabled: true },
    { id: 'p', type: 'payment' as const, enabled: true },
  ],
}

describe('resolveReceiptLayout', () => {
  it('a pull without receiptTemplate still prints Standar (bytes equal buildReceipt)', () => {
    const layout = resolveReceiptLayout(undefined, receipt)
    expect(layout.compat).toBe('v1')
    expect(Array.from(receiptBytes(layout, data))).toEqual(Array.from(buildReceipt(data, receipt)))
  })

  it('uses the pulled template when it is usable', () => {
    const layout = resolveReceiptLayout(good, receipt)
    expect(layout.compat).toBeUndefined()
    expect(layout.blocks.map((b) => b.id)).toEqual(['i', 'o', 'p'])
  })

  it('prints Standar when the pulled template lost its payment block', () => {
    const layout = resolveReceiptLayout({ ...good, blocks: good.blocks.slice(0, 2) }, receipt)
    expect(layout.compat).toBe('v1')
    expect(Array.from(receiptBytes(layout, data))).toEqual(Array.from(buildReceipt(data, receipt)))
  })

  it('prints Standar for a template with an unknown paper width', () => {
    expect(resolveReceiptLayout({ ...good, paperWidth: 70 as never }, receipt).compat).toBe('v1')
  })
})

describe('receipt extras', () => {
  it('receiptOutlet carries name, address and phone, null when the pull has none', () => {
    expect(receiptOutlet({ outletName: 'Kuta', outletAddress: 'Jl. 1', outletPhone: '0361' })).toEqual({ name: 'Kuta', address: 'Jl. 1', phone: '0361' })
    expect(receiptOutlet({})).toEqual({ name: '', address: null, phone: null })
  })

  it('receiptPoints needs loyalty on and a customer, and nets out redeemed points', () => {
    const derived = { earnedPoints: 80, redeemedPoints: 20 }
    expect(receiptPoints(true, 1000, derived)).toEqual({ earned: 80, balance: 1060 })
    expect(receiptPoints(false, 1000, derived)).toBeUndefined()
    expect(receiptPoints(true, null, derived)).toBeUndefined()
    expect(receiptPoints(true, undefined, derived)).toBeUndefined()
  })
})
