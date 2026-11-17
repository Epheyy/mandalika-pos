import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LocalReceipt } from '@mandalika/sync'
import { reprintReceiptData } from './localReceipts'
import { receiptFromQuote } from './receiptQuote'

// CashierScreen is too large to mount in a unit test, so the print wiring is pinned from its source: every receipt
// and slip print goes through the outlet's layout, and only the live sale carries estimated points.
const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')

const callsOf = (needle: string): string[] => src.split('\n').filter((l) => l.includes(needle))

describe('CashierScreen passes the receipt layout to every print', () => {
  it('resolves the layout once from the pulled template and the receipt settings', () => {
    expect(src).toContain('resolveReceiptLayout(snapshot.receiptTemplate, settings.receipt)')
  })

  it('every receipt print (sale, retry, reprints) passes receiptLayout', () => {
    const prints = callsOf('.print(')
    expect(prints).toHaveLength(4) // the sale, handleReprint, reprintLocal, reprintOrder
    for (const l of prints) expect(l).toContain('receiptLayout')
  })

  it('every DIBATALKAN slip print passes receiptLayout', () => {
    const slips = src.split('\n').filter((l) => l.includes('printVoidSlip('))
    expect(slips).toHaveLength(2)
    for (const l of slips) expect(l).toContain('receiptLayout')
  })

  it('the live sale carries outlet and points; a local-receipt and a history reprint carry outlet only', () => {
    const sale = src.slice(src.indexOf('const receipt: ReceiptData = receiptFromQuote('), src.indexOf('if (voidDraft) receipt.replacesOrderRef'))
    expect(sale).toContain('outlet: receiptOutlet(snapshot)')
    expect(sale).toContain('points: receiptPoints(')
    expect(src).toContain('reprintReceiptData(r, receiptOutlet(snapshot))')
    const history = src.slice(src.indexOf('const reprintOrder = '), src.indexOf('/** What this tablet saw acknowledged'))
    expect(history).toContain('outlet: receiptOutlet(snapshot)')
    expect(history).not.toContain('points')
  })
})

describe('printer.tsx clamps every layout print to the device paper', () => {
  it('passes the tablet Lebar kertas and Cetak logo & QR settings with the layout', () => {
    const printerSrc = readFileSync(new URL('../printer.tsx', import.meta.url), 'utf8')
    expect(printerSrc).toContain('maxPaperWidth: devicePaperWidth()')
    expect(printerSrc).toContain('graphics: deviceGraphics()')
  })
})

describe('receipt extras reach the slip data', () => {
  const quote = { quotedTotal: 1000, receiptSnapshot: { v: 2, lines: [], subtotal: 1000, discountAmount: 0, discounts: [], surchargeAmount: 0, redeemAmount: 0, roundingAmount: 0, taxAmount: 0, amountPaid: 1000, change: 0 } } as never
  const base = { orderRef: 'T1', dateTime: new Date(0), paymentLabel: 'Tunai', customerName: null, customerPhone: null, cashierName: 'Kasir' }

  it('receiptFromQuote keeps outlet and points', () => {
    const d = receiptFromQuote(quote, { ...base, outlet: { name: 'Kuta', address: null, phone: null }, points: { earned: 1, balance: 2 } })
    expect(d.outlet?.name).toBe('Kuta')
    expect(d.points).toEqual({ earned: 1, balance: 2 })
  })

  it('reprintReceiptData adds the outlet and never points', () => {
    const rec = { orderNumber: 'B1', capturedAt: '2026-11-12T03:00:00.000Z', paymentMethod: 'cash', quotedTotal: 1000, receiptSnapshot: (quote as { receiptSnapshot: unknown }).receiptSnapshot } as unknown as LocalReceipt
    const d = reprintReceiptData(rec, { name: 'Kuta', address: 'Jl. 1', phone: null })!
    expect(d.outlet).toEqual({ name: 'Kuta', address: 'Jl. 1', phone: null })
    expect(d.points).toBeUndefined()
    expect(reprintReceiptData(rec)!.outlet).toBeUndefined()
  })
})
