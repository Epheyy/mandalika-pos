import { describe, expect, it } from 'vitest'
import { buildReceiptQuote, receiptFromQuote } from './receiptQuote'

const derived = { subtotal: 210000, discountAmount: 10000, surchargeAmount: 0, taxAmount: 20000, redeemAmount: 5000, total: 215000 }
const tender = { amountPaid: 250000, change: 35000 }
const cart = [
  { productId: 'p1', productName: 'Parfum A', variantSize: '110ml', price: 100000, quantity: 2, subtotal: 200000 },
  { productId: 'p2', productName: 'Parfum B', variantSize: '', price: 10000, quantity: 1, subtotal: 10000, isReward: true },
  { productId: 'p3', productName: 'Paket', variantSize: '30ml', price: 0, quantity: 1, subtotal: 0, isBundle: true },
]
const extras = { orderRef: 'BSD-AB0001', dateTime: new Date('2026-10-19T03:00:00Z'), paymentLabel: 'Tunai', customerName: 'Budi Santoso', customerPhone: '081234567890', cashierName: 'Sari' }

describe('A10 buildReceiptQuote', () => {
  it('quotes the derived total and records the money exactly as shown', () => {
    const q = buildReceiptQuote({ cart, derived, tender, refVersion: 42 })
    expect(q.quotedTotal).toBe(215000)
    expect(q.receiptSnapshot).toMatchObject({ v: 1, refVersion: 42, subtotal: 210000, discountAmount: 10000, surchargeAmount: 0, taxAmount: 20000, redeemAmount: 5000, total: 215000, amountPaid: 250000, change: 35000 })
  })

  it('keeps the lines as displayed, flagging reward and bundle lines only when set', () => {
    const { receiptSnapshot } = buildReceiptQuote({ cart, derived, tender, refVersion: 1 })
    expect(receiptSnapshot.lines).toEqual([
      { productId: 'p1', variantSize: '110ml', name: 'Parfum A', qty: 2, unitPrice: 100000, amount: 200000 },
      { productId: 'p2', variantSize: '', name: 'Parfum B', qty: 1, unitPrice: 10000, amount: 10000, isReward: true },
      { productId: 'p3', variantSize: '30ml', name: 'Paket', qty: 1, unitPrice: 0, amount: 0, isBundle: true },
    ])
  })

  it('prints exactly what was quoted: one object feeds the payload and the receipt', () => {
    const q = buildReceiptQuote({ cart, derived, tender, refVersion: 1 })
    const receipt = receiptFromQuote(q, extras)
    expect(receipt.total).toBe(q.quotedTotal)
    expect(receipt.subtotal).toBe(q.receiptSnapshot.subtotal)
    expect(receipt.discountAmount).toBe(q.receiptSnapshot.discountAmount)
    expect(receipt.taxAmount).toBe(q.receiptSnapshot.taxAmount)
    expect(receipt.amountPaid).toBe(q.receiptSnapshot.amountPaid)
    expect(receipt.change).toBe(q.receiptSnapshot.change)
    expect(receipt.lines.map((l) => [l.name, l.qty, l.unitPrice, l.amount])).toEqual(
      q.receiptSnapshot.lines.map((l) => [l.name, l.qty, l.unitPrice, l.amount]),
    )
    expect(receipt.lines[1]!.variant).toBeUndefined()
    expect(receipt.lines[0]!.variant).toBe('110ml')
    expect(receipt.customerName).toBe('Budi Santoso') // printed, but never part of the quote
  })

  it('never carries the customer name or phone into the snapshot', () => {
    const q = buildReceiptQuote({ cart, derived, tender, refVersion: 1 })
    const json = JSON.stringify(q)
    expect(json).not.toContain('Budi')
    expect(json).not.toContain('0812')
    expect(Object.keys(q.receiptSnapshot)).not.toContain('customerName')
    expect(Object.keys(q.receiptSnapshot)).not.toContain('customerPhone')
  })

  it('does not alias the caller cart', () => {
    const q = buildReceiptQuote({ cart, derived, tender, refVersion: 1 })
    q.receiptSnapshot.lines[0]!.qty = 99
    expect(cart[0]!.quantity).toBe(2)
  })
})
