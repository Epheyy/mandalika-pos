import { describe, it, expect } from 'vitest'
import { buildReceipt, COLS, type ReceiptData } from './escpos'
import type { components } from '@mandalika/api'

type ReceiptSettings = components['schemas']['ReceiptSettings']

// Strip ESC/POS control sequences (init/align/bold/size/feed/cut) and return the printed text lines.
function slip(u: Uint8Array): string[] {
  const out: number[] = []
  for (let i = 0; i < u.length; i++) {
    const c = u[i]!
    if (c === 0x1b) { i += c === 0x1b && u[i + 1] === 0x40 ? 1 : 2; continue }
    if (c === 0x1d) { i += u[i + 1] === 0x56 ? 3 : 2; continue }
    out.push(c)
  }
  return String.fromCharCode(...out).split('\n').slice(0, -1)
}
const settings = { headerText: 'TOKO', footerText: '', showTax: true } as ReceiptSettings
const base: ReceiptData = {
  orderRef: 'T1', pending: false, dateTime: new Date('2026-05-29T00:00:00Z'),
  lines: [], subtotal: 0, discountAmount: 0, taxAmount: 0, total: 0,
  paymentLabel: 'Tunai', amountPaid: 0, change: 0, customerName: null, customerPhone: null, cashierName: 'Kasir',
}
const row = (lines: string[], prefix: string) => lines.find((l) => l.startsWith(prefix))
const numeric = (s: string) => Number(s.replace(/\D/g, ''))
const amt = (l: string | undefined) => numeric(l!.slice(l!.lastIndexOf(' ') + 1))

describe('C1 receipt rows', () => {
  it('plain sale: lines, subtotal, total, bayar, kembalian, every row within 32 columns', () => {
    const data: ReceiptData = {
      ...base,
      lines: [{ name: 'Parfum Melati', variant: '50ml', qty: 2, unitPrice: 100000, amount: 200000 }],
      subtotal: 200000, discounts: [], total: 200000, amountPaid: 250000, change: 50000,
    }
    const lines = slip(buildReceipt(data, settings))
    expect(lines.every((l) => l.length <= COLS)).toBe(true)
    expect(row(lines, '  2 x 100.000')).toMatch(/200\.000$/)
    expect(amt(row(lines, 'Subtotal'))).toBe(200000)
    expect(amt(row(lines, 'TOTAL'))).toBe(200000)
    expect(amt(row(lines, 'Tunai'))).toBe(250000)
    expect(amt(row(lines, 'Kembalian'))).toBe(50000)
    expect(lines.some((l) => l.includes('Diskon'))).toBe(false)
  })

  it('two promos + a code + manual discount: one named row each, adds up', () => {
    const data: ReceiptData = {
      ...base,
      lines: [{ name: 'Parfum A', qty: 1, unitPrice: 300000, amount: 300000 }],
      subtotal: 300000, discountAmount: 70000,
      discounts: [
        { label: 'Promo Beli 2 hemat 10%', amount: 30000 },
        { label: 'Promo Akhir Pekan', amount: 15000 },
        { label: 'Kode PROMO10', amount: 15000 },
        { label: 'Diskon manual', amount: 10000 },
      ],
      taxAmount: 25300, total: 255300, amountPaid: 300000, change: 44700,
    }
    const lines = slip(buildReceipt(data, settings))
    expect(lines.every((l) => l.length <= COLS)).toBe(true)
    // The long first label wraps onto its own line; the amount sits right-aligned below it.
    const first = lines.findIndex((l) => l === '- Promo Beli 2 hemat 10%')
    expect(first).toBeGreaterThan(0)
    expect(lines[first + 1]).toBe(' '.repeat(COLS - 9) + '-Rp30.000')
    expect(lines).toContain('- Promo Akhir Pekan' + ' '.repeat(COLS - 19 - 9) + '-Rp15.000')
    expect(lines).toContain('- Kode PROMO10' + ' '.repeat(COLS - 14 - 9) + '-Rp15.000')
    expect(lines).toContain('- Diskon manual' + ' '.repeat(COLS - 15 - 9) + '-Rp10.000')
    const amounts = [30000, 15000, 15000, 10000]
    const discountRows = lines.filter((l) => /-Rp[\d.]+$/.test(l))
    expect(discountRows.map(amt)).toEqual(amounts)
    expect(lines.some((l) => /^Diskon\s/.test(l))).toBe(false)
    const sum = amt(row(lines, 'Subtotal')) - discountRows.reduce((s, l) => s + amt(l), 0) + amt(row(lines, 'PPN'))
    expect(sum).toBe(amt(row(lines, 'TOTAL')))
  })

  it('GRATIS reward line and bundle free item print GRATIS + HADIAH tag, never a bare 0', () => {
    const data: ReceiptData = {
      ...base,
      lines: [
        { name: 'Parfum A', qty: 2, unitPrice: 100000, amount: 200000 },
        { name: 'Parfum Hadiah Loyalti Spesial Edisi', qty: 1, unitPrice: 50000, amount: 0, isReward: true },
        { name: 'Paket Bundel', variant: '30ml', qty: 1, unitPrice: 0, amount: 0, isReward: true, rewardLabel: 'Bundel' },
      ],
      subtotal: 200000, discounts: [], total: 200000, amountPaid: 200000, change: 0,
    }
    const lines = slip(buildReceipt(data, settings))
    expect(lines.every((l) => l.length <= COLS)).toBe(true)
    expect(lines.filter((l) => /GRATIS$/.test(l))).toHaveLength(2)
    expect(lines.some((l) => l.includes('[HADIAH]'))).toBe(true)
    expect(lines.some((l) => l.includes('[BUNDEL]'))).toBe(true)
    expect(lines.some((l) => /\b0$/.test(l) && l.includes(' x '))).toBe(false)
    expect(amt(row(lines, 'TOTAL'))).toBe(200000)
  })

  it('wraps a long item name onto at most two lines', () => {
    const data: ReceiptData = {
      ...base,
      lines: [{ name: 'Parfum Edisi Terbatas Mandalika Sunset Bali 2026 Premium Collection', qty: 1, unitPrice: 1000, amount: 1000 }],
      subtotal: 1000, discounts: [], total: 1000, amountPaid: 1000,
    }
    const lines = slip(buildReceipt(data, settings))
    const idx = lines.findIndex((l) => l.startsWith('  1 x 1.000'))
    const nameLines = lines.slice(lines.findIndex((l) => l.startsWith('Parfum Edisi')), idx)
    expect(nameLines.length).toBeLessThanOrEqual(2)
    expect(lines.every((l) => l.length <= COLS)).toBe(true)
  })

  it('surcharge (Biaya tambahan) and redeemed points: adds up with rounding', () => {
    const data: ReceiptData = {
      ...base,
      lines: [{ name: 'Parfum A', qty: 1, unitPrice: 100000, amount: 100000 }],
      subtotal: 100000, discountAmount: 0, discounts: [],
      surcharge: 5000, pointsRedeemed: { points: 20, amount: 20000 }, taxAmount: 11000, rounding: -100,
      total: 95900, amountPaid: 100000, change: 4100,
    }
    const lines = slip(buildReceipt(data, settings))
    expect(lines.every((l) => l.length <= COLS)).toBe(true)
    expect(lines.some((l) => l.includes('Surcharge'))).toBe(false)
    const sur = amt(row(lines, 'Biaya tambahan'))
    const pts = amt(row(lines, 'Tukar poin'))
    expect(row(lines, 'Tukar poin')).toMatch(/-Rp20\.000$/)
    const round = -amt(row(lines, 'Pembulatan'))
    expect(round).toBe(-100)
    expect(amt(row(lines, 'Subtotal')) + sur - pts + amt(row(lines, 'PPN')) + round).toBe(amt(row(lines, 'TOTAL')))
  })

  it('archived pre-C1 receipt (no new fields) falls back to a single Diskon row and plain amounts', () => {
    const v0: ReceiptData = {
      ...base,
      lines: [{ name: 'Parfum A', qty: 2, unitPrice: 50000, amount: 100000 }],
      subtotal: 100000, discountAmount: 10000, taxAmount: 0, total: 90000, amountPaid: 100000, change: 10000,
    }
    const lines = slip(buildReceipt(v0, settings))
    expect(lines.every((l) => l.length <= COLS)).toBe(true)
    expect(lines.filter((l) => l.startsWith('Diskon'))).toHaveLength(1)
    expect(row(lines, 'Diskon')).toMatch(/-10\.000$/)
    expect(lines.some((l) => l.includes('GRATIS') || l.includes('HADIAH'))).toBe(false)
    expect(amt(row(lines, 'Subtotal')) - 10000).toBe(amt(row(lines, 'TOTAL')))
  })
})
