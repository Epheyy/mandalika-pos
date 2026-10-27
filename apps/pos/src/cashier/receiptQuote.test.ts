import { describe, expect, it } from 'vitest'
import { buildReceiptQuote, receiptAddsUp, receiptFromQuote } from './receiptQuote'

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
    expect(q.receiptSnapshot).toMatchObject({ v: 2, refVersion: 42, subtotal: 210000, discountAmount: 10000, surchargeAmount: 0, taxAmount: 20000, redeemAmount: 5000, total: 215000, amountPaid: 250000, change: 35000 })
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

describe('C1 receipt parity', () => {
  const c1Derived = {
    subtotal: 210000, discountAmount: 30000, surchargeAmount: 5000, taxAmount: 19800, redeemAmount: 20000,
    discountParts: [{ label: 'Promo Akhir Pekan', amount: 20000 }, { label: 'Diskon manual', amount: 10000 }],
    redeemedPoints: 20, roundingAmount: -200, total: 184600,
  }

  it('fills itemised discounts, biaya tambahan, poin, rounding and reward flags from the checkout totals', () => {
    const q = buildReceiptQuote({ cart, derived: c1Derived, tender: { amountPaid: 200000, change: 15400 }, refVersion: 1 })
    const r = receiptFromQuote(q, extras)
    expect(r.discounts).toEqual(c1Derived.discountParts)
    expect(r.surcharge).toBe(5000)
    expect(r.pointsRedeemed).toEqual({ points: 20, amount: 20000 })
    expect(r.rounding).toBe(-200)
    expect(r.lines.map((l) => l.isReward)).toEqual([false, true, false])
    expect(receiptAddsUp(r)).toBe(true)
  })

  it('degrades a missing itemisation to a single Diskon row', () => {
    const q = buildReceiptQuote({ cart, derived, tender, refVersion: 1 })
    expect(receiptFromQuote(q, extras).discounts).toEqual([{ label: 'Diskon', amount: 10000 }])
  })

  it('a pre-C1 (v1) archived snapshot gets no itemised fields, so the printer falls back', () => {
    const q = buildReceiptQuote({ cart, derived, tender, refVersion: 1 })
    const v1 = { ...q, receiptSnapshot: { ...q.receiptSnapshot, v: 1 as const } }
    const r = receiptFromQuote(v1, extras)
    expect(r.discounts).toBeUndefined()
    expect(r.surcharge).toBeUndefined()
    expect(r.pointsRedeemed).toBeUndefined()
    expect(r.lines.every((l) => l.isReward === undefined)).toBe(true)
  })

  it('receiptAddsUp rejects a slip whose rows do not reach the total', () => {
    const q = buildReceiptQuote({ cart, derived: c1Derived, tender: { amountPaid: 200000, change: 15400 }, refVersion: 1 })
    const r = receiptFromQuote(q, extras)
    expect(receiptAddsUp({ ...r, total: r.total + 1 })).toBe(false)
    expect(receiptAddsUp({ ...r, surcharge: null })).toBe(false)
    expect(receiptAddsUp({ ...r, lines: [] })).toBe(false)
  })
})

