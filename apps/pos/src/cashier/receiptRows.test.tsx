import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildReceipt } from '@mandalika/printer'
import { buildReceiptQuote, receiptFromQuote } from './receiptQuote'
import { quoteTotalRows, receiptTenderRows, receiptTotalRows } from './receiptRows'
import { ReceiptTotals } from './ReceiptTotals'

// Decode the printed slip to text lines (strip ESC/GS control sequences), as the printer snapshots do.
function slip(u: Uint8Array): string[] {
  const out: number[] = []
  for (let i = 0; i < u.length; i++) {
    const c = u[i]!
    if (c === 0x1b) { i += u[i + 1] === 0x40 ? 1 : 2; continue }
    if (c === 0x1d) { i += u[i + 1] === 0x56 ? 3 : 2; continue }
    out.push(c)
  }
  return String.fromCharCode(...out).split('\n').slice(0, -1)
}
const settings = { headerText: 'TOKO', footerText: '', showTax: true, showSubtotal: true, showDiscount: true } as never
const extras = { orderRef: 'T1', dateTime: new Date('2026-10-27T03:00:00Z'), paymentLabel: 'Tunai', customerName: null, customerPhone: null, cashierName: 'Kasir' }
const cart = [{ productId: 'p1', productName: 'Parfum A', variantSize: '', price: 300000, quantity: 1, subtotal: 300000 }]
const full = {
  subtotal: 300000, discountAmount: 70000, surchargeAmount: 5000, taxAmount: 24000, redeemAmount: 20000, total: 238000,
  discountParts: [{ label: 'Promo Akhir Pekan', amount: 30000 }, { label: 'Kode PROMO10', amount: 30000 }, { label: 'Diskon manual', amount: 10000 }],
  redeemedPoints: 200, roundingAmount: -1000,
}
const numbers = (s: string) => Number(s.replace(/\D/g, ''))

describe('on-screen totals match the printed receipt (C1 follow-up)', () => {
  it('lists the same rows, in the same order, with the same amounts as the printer', () => {
    const rows = quoteTotalRows(cart, full, settings)
    const lines = slip(buildReceipt(receiptFromQuote(buildReceiptQuote({ cart, derived: full, tender: { amountPaid: 250000, change: 11000 }, refVersion: 0 }), extras), settings))
    let cursor = 0
    for (const r of rows) {
      const printedLabel = r.kind === 'promo' ? `- ${r.label}` : r.label
      const at = lines.findIndex((l, i) => i >= cursor && l.startsWith(printedLabel))
      expect(at, `row ${r.label} not printed in order`).toBeGreaterThanOrEqual(cursor)
      cursor = at
      const printed = lines[at]!
      expect(numbers(printed.slice(printed.lastIndexOf(' ') + 1))).toBe(Math.abs(r.amount))
      if (r.kind === 'promo' || r.kind === 'points') expect(printed).toContain('-Rp')
    }
    expect(rows.map((r) => r.kind)).toEqual(['subtotal', 'promo', 'promo', 'promo', 'surcharge', 'points', 'tax', 'rounding', 'total'])
  })

  it('adds up: the signed rows sum to the total', () => {
    const rows = quoteTotalRows(cart, full, settings)
    expect(rows.slice(0, -1).reduce((s, r) => s + r.amount, 0)).toBe(238000)
    expect(rows.at(-1)!.amount).toBe(238000)
  })

  it('shows no Pembulatan, Biaya tambahan or Tukar poin rows when they are zero', () => {
    const plain = { subtotal: 300000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: 300000 }
    expect(quoteTotalRows(cart, plain, settings).map((r) => r.kind)).toEqual(['subtotal', 'total'])
  })

  it('a pre-C1 receipt falls back to one Diskon row, like the printer', () => {
    const rows = receiptTotalRows({ subtotal: 100000, discountAmount: 10000, discounts: undefined, surcharge: undefined, pointsRedeemed: undefined, rounding: undefined, taxAmount: 0, total: 90000 }, settings)
    expect(rows.map((r) => [r.label, r.amount])).toEqual([['Subtotal', 100000], ['Diskon', -10000], ['TOTAL', 90000]])
  })

  it('an itemised slip keeps its discount and PPN rows even when the print toggles are off (as the printer does)', () => {
    const off = { showSubtotal: false, showDiscount: false, showTax: false }
    const rows = quoteTotalRows(cart, full, off)
    expect(rows.map((r) => r.kind)).toEqual(['promo', 'promo', 'promo', 'surcharge', 'points', 'tax', 'rounding', 'total'])
    const lines = slip(buildReceipt(receiptFromQuote(buildReceiptQuote({ cart, derived: full, tender: { amountPaid: 250000, change: 12000 }, refVersion: 0 }), extras), Object.assign({}, settings, off) as never))
    for (const r of rows) {
      const label = r.kind === 'promo' ? `- ${r.label}` : r.label
      expect(lines.some((l) => l.startsWith(label)), `printed ${r.label}`).toBe(true)
    }
    expect(lines.some((l) => l.startsWith('Subtotal'))).toBe(false)
  })

  it('a pre-C1 receipt still follows the print toggles', () => {
    const legacy = { subtotal: 100000, discountAmount: 10000, discounts: undefined, surcharge: undefined, pointsRedeemed: undefined, rounding: undefined, taxAmount: 9000, total: 99000 }
    expect(receiptTotalRows(legacy, { showSubtotal: true, showDiscount: false, showTax: false }).map((r) => r.kind)).toEqual(['subtotal', 'total'])
  })

  it('renders one named row per promo with the promo colour', () => {
    const html = renderToStaticMarkup(createElement(ReceiptTotals, { rows: quoteTotalRows(cart, full, settings) }))
    expect(html).toContain('Promo Akhir Pekan')
    expect(html).toContain('Kode PROMO10')
    expect(html).toContain('Diskon manual')
    expect(html).toContain('Tukar poin (200)')
    expect(html).toContain('Pembulatan')
    expect(html).toContain('text-promo')
    expect(html).toContain('text-reward')
  })
})

describe('C6 split tender rows match the printed receipt', () => {
  const sale = { subtotal: 1251000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: 1251000 }
  const tenders = [
    { method: 'qris', label: 'QRIS', amount: 751000, reference: '8812345' },
    { method: 'cash', label: 'Tunai', amount: 600000 },
  ]
  const data = receiptFromQuote(
    buildReceiptQuote({ cart, derived: sale, tender: { amountPaid: 1351000, change: 100000 }, refVersion: 0, tenders }),
    { ...extras, paymentLabel: 'Split-Payment' },
  )

  it('lists the same payment rows, in order, with amounts and Ref lines as the slip', () => {
    const rows = receiptTenderRows(data)
    expect(rows.map((r) => [r.label, r.amount, r.reference])).toEqual([['QRIS', 751000, '8812345'], ['Tunai', 600000, undefined]])
    const lines = slip(buildReceipt(data, settings))
    const at = lines.findIndex((l) => l.startsWith('QRIS'))
    expect(numbers(lines[at]!.slice(lines[at]!.lastIndexOf(' ') + 1))).toBe(751000)
    expect(lines[at + 1]).toBe('  Ref 8812345')
    expect(lines[at + 2]!.startsWith('Tunai')).toBe(true)
    expect(lines.some((l) => l.startsWith('Kembalian'))).toBe(true)
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(data.amountPaid)
  })

  it('a one-method sale keeps the single paymentLabel row', () => {
    const plain = receiptFromQuote(buildReceiptQuote({ cart, derived: sale, tender: { amountPaid: 1300000, change: 49000 }, refVersion: 0 }), extras)
    expect(receiptTenderRows(plain)).toEqual([{ key: 'tender-0', label: 'Tunai', amount: 1300000 }])
  })

  it('an empty tenders list leaves the snapshot byte-identical to a plain sale', () => {
    const base = buildReceiptQuote({ cart, derived: sale, tender: { amountPaid: 1, change: 0 }, refVersion: 0 })
    const empty = buildReceiptQuote({ cart, derived: sale, tender: { amountPaid: 1, change: 0 }, refVersion: 0, tenders: [] })
    expect(JSON.stringify(empty)).toBe(JSON.stringify(base))
    expect(base.receiptSnapshot.tenders).toBeUndefined()
  })
})
