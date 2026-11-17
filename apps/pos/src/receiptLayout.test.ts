import { describe, expect, it } from 'vitest'
import { buildReceipt, type ReceiptData, type ReceiptLayout } from '@mandalika/printer'
import { receiptBytes } from '@mandalika/printer/render'
import { chooseTestPrintLayout, deviceGraphics, devicePaperWidth, receiptOutlet, receiptPoints, resolveReceiptLayout, setDeviceGraphics, setDevicePaperWidth } from './receiptLayout'

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

const memKV = () => {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) }
}

describe('device printer settings', () => {
  it('default to 58mm with graphics on, and read what was saved', () => {
    const kv = memKV()
    expect(devicePaperWidth(kv)).toBe(58)
    expect(deviceGraphics(kv)).toBe(true)
    setDevicePaperWidth(80, kv)
    setDeviceGraphics(false, kv)
    expect(devicePaperWidth(kv)).toBe(80)
    expect(deviceGraphics(kv)).toBe(false)
    setDeviceGraphics(true, kv)
    expect(deviceGraphics(kv)).toBe(true)
  })

  it('an unknown stored value falls back to 58mm', () => {
    const kv = memKV()
    kv.set('mandalika.pos.printerPaperWidth', '72')
    expect(devicePaperWidth(kv)).toBe(58)
  })

  it('Lebar kertas 80 lets a 48-column template print at 48', () => {
    const layout: ReceiptLayout = { paperWidth: 80, blocks: [
      { id: 'd', type: 'divider', enabled: true },
      { id: 'i', type: 'items', enabled: true },
      { id: 'o', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
      { id: 'p', type: 'payment', enabled: true },
    ] }
    const kv = memKV()
    const count = (w: number): number => {
      const bytes = receiptBytes(layout, data, { maxPaperWidth: w as 58 | 80 })
      return String.fromCharCode(...bytes).split('\n').flatMap((l) => l.match(/-{20,}/g) ?? []).map((l) => l.length)[0] ?? 0
    }
    expect(count(devicePaperWidth(kv))).toBe(32)
    setDevicePaperWidth(80, kv)
    expect(count(devicePaperWidth(kv))).toBe(48)
  })
})

describe('chooseTestPrintLayout', () => {
  const draft = {
    id: 'x', version: 0, paperWidth: 58 as const,
    blocks: [{ id: 'hd', type: 'text' as const, enabled: true, text: 'DRAFT', align: 'left' as const, bold: false, size: 'normal' as const }, ...good.blocks],
  }

  it('prints a pending Backoffice draft with a CETAK TES line, else the outlet template', async () => {
    const withDraft = await chooseTestPrintLayout(async () => draft, good, receipt)
    expect(withDraft.fromDraft).toBe(true)
    expect(withDraft.layout.blocks[0]).toMatchObject({ type: 'text', text: '*** CETAK TES ***' })
    expect(withDraft.layout.blocks.some((b) => b.id === 'hd')).toBe(true)

    const none = await chooseTestPrintLayout(async () => null, good, receipt)
    expect(none.fromDraft).toBe(false)
    expect(none.layout.blocks.map((b) => b.id)).toEqual(['cetak-tes', 'i', 'o', 'p']) // the outlet's own layout is marked too
  })

  it('falls back to the outlet layout when offline, or when the draft cannot be trusted', async () => {
    const offline = await chooseTestPrintLayout(async () => { throw new Error('network') }, good, receipt)
    expect(offline.fromDraft).toBe(false)
    const broken = await chooseTestPrintLayout(async () => ({ ...draft, blocks: [draft.blocks[0]!] }), undefined, receipt)
    expect(broken.fromDraft).toBe(false)
    expect(broken.layout.compat).toBe('v1')
    expect(broken.layout.blocks[0]).toMatchObject({ text: '*** CETAK TES ***' }) // Standar is marked as well
  })

  it('a sale after a Tes Cetak with a relay draft prints the pulled template, not the draft', async () => {
    await chooseTestPrintLayout(async () => draft, good, receipt)
    // Sales only ever resolve from the pulled snapshot; the draft is never stored anywhere.
    const sale = resolveReceiptLayout(good, receipt)
    expect(sale.blocks.map((b) => b.id)).toEqual(['i', 'o', 'p'])
    const bytes = String.fromCharCode(...receiptBytes(sale, data))
    expect(bytes).not.toContain('DRAFT')
    expect(bytes).not.toContain('CETAK TES')
  })
})
