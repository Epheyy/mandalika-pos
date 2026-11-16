import { describe, it, expect } from 'vitest'
import type { ReceiptData } from './data'
import type { ReceiptBlock, ReceiptLayout, PaperWidth } from './layout'
import { COLS_BY_WIDTH } from './layout'
import { receiptBytes, receiptPreview } from './render'
import { NEW_TEMPLATE_BLOCKS, SAMPLE_RECEIPT } from './sample'

interface Printed { text: string; large: boolean }

/** Parse ESC/POS bytes back into printed lines, tracking GS ! (large). */
function parse(u: Uint8Array): Printed[] {
  const out: Printed[] = []
  let cur: number[] = []
  let large = false
  let lineLarge = false
  for (let i = 0; i < u.length; i++) {
    const c = u[i]!
    if (c === 0x1b) { i += u[i + 1] === 0x40 ? 1 : 2; continue }
    if (c === 0x1d) {
      if (u[i + 1] === 0x21) { large = u[i + 2] !== 0; i += 2 } else i += 3
      continue
    }
    if (c === 0x0a) { out.push({ text: String.fromCharCode(...cur), large: lineLarge }); cur = []; continue }
    if (cur.length === 0) lineLarge = large
    cur.push(c)
  }
  return out
}

const LONG = 'Nama yang sangat panjang sekali sampai harus dibungkus ke beberapa baris pada kertas'
const TRICKY = 'Café … ﬁnal “Bunga” ☺ ' + 'x'.repeat(40)

function longData(): ReceiptData {
  return {
    ...SAMPLE_RECEIPT,
    orderRef: 'OFFLINE-0123456789abcdef0123456789',
    lines: [
      { name: 'P'.repeat(70), variant: TRICKY, qty: 12, unitPrice: 1999999, amount: 23999988, pieces: [LONG, TRICKY],
        lineDiscount: { label: 'Diskon bundle spesial untuk pelanggan setia ' + 'z'.repeat(20), amount: 85000 } },
      { name: TRICKY, qty: 1, unitPrice: 0, amount: 0, isReward: true, rewardLabel: 'Hadiah ' + 'h'.repeat(40) },
    ],
    subtotal: 23999988,
    discounts: [{ label: 'D'.repeat(40) + ' ' + LONG, amount: 1000 }],
    surcharge: 2000, pointsRedeemed: { points: 5000, amount: 50000 }, rounding: -300, taxAmount: 11000, correctionAmount: 5000,
    total: 23999988,
    tenders: [{ label: 'Kartu kredit bank dengan nama panjang', amount: 23999988, reference: 'R'.repeat(60) }],
    change: 1234567,
    customerName: 'C'.repeat(60), customerPhone: '0812' + '3'.repeat(30), cashierName: LONG,
    replacesOrderRef: 'MND-' + 'R'.repeat(40),
    outlet: { name: 'Outlet ' + 'O'.repeat(50), address: LONG + ' ' + TRICKY, phone: '021-' + '5'.repeat(30) },
    points: { earned: 123456, balance: 9999999 },
  }
}

const textBlock = (id: string, text: string, align: 'left' | 'center' | 'right', bold: boolean, size: 'normal' | 'large'): ReceiptBlock =>
  ({ id, type: 'text', enabled: true, text, align, bold, size })

function everyBlockLayout(width: PaperWidth): ReceiptLayout {
  const blocks: ReceiptBlock[] = [
    { id: 'h-large', type: 'header', enabled: true, text: 'T'.repeat(64), size: 'large', showOutletName: true, showOutletAddress: true, showOutletPhone: true },
    { id: 'h-normal', type: 'header', enabled: true, text: TRICKY, size: 'normal', showOutletName: true, showOutletAddress: true, showOutletPhone: true },
    { id: 'tx-columns', type: 'transaction', enabled: true, fields: ['orderNumber', 'date', 'cashier', 'customerName', 'customerPhone'], style: 'columns' },
    { id: 'tx-inline', type: 'transaction', enabled: true, fields: ['customerName', 'customerPhone', 'cashier', 'orderNumber'], style: 'inline' },
    { id: 'd1', type: 'divider', enabled: true },
    { id: 'items', type: 'items', enabled: true },
    { id: 'totals', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
    { id: 'payment', type: 'payment', enabled: true },
    { id: 'points', type: 'points', enabled: true },
  ]
  for (const align of ['left', 'center', 'right'] as const) {
    for (const size of ['normal', 'large'] as const) {
      blocks.push(textBlock(`t-${align}-${size}`, ('Teks panjang ' + TRICKY + ' ').repeat(5).slice(0, 500) + '\n\n' + 'w'.repeat(70), align, true, size))
    }
  }
  return { paperWidth: width, blocks }
}

describe('no printed line exceeds the paper width', () => {
  for (const width of [58, 80] as const) {
    const cols = COLS_BY_WIDTH[width]
    for (const [name, layout] of [
      ['NEW_TEMPLATE_BLOCKS', { paperWidth: width, blocks: NEW_TEMPLATE_BLOCKS } as ReceiptLayout],
      ['every block type', everyBlockLayout(width)],
    ] as const) {
      for (const reprint of [false, true]) {
        it(`${name} at ${cols} columns (reprint ${reprint}): bytes and preview agree and fit`, () => {
          const data = longData()
          const lines = parse(receiptBytes(layout, data, { reprint }))
          expect(lines.length).toBeGreaterThan(10)
          for (const l of lines) expect(l.text.length * (l.large ? 2 : 1), JSON.stringify(l)).toBeLessThanOrEqual(cols)
          const preview = receiptPreview(layout, data, { reprint })
          for (const p of preview) expect(p.text.length * (p.large ? 2 : 1), JSON.stringify(p)).toBeLessThanOrEqual(cols)
          expect(preview.map((p) => p.text)).toEqual(lines.map((l) => l.text))
          expect(preview.map((p) => p.large)).toEqual(lines.map((l) => l.large))
        })
      }
    }
  }

  it('renders a 48-column template at 32 columns when the device width is 58', () => {
    const layout: ReceiptLayout = { paperWidth: 80, blocks: NEW_TEMPLATE_BLOCKS }
    const lines = parse(receiptBytes(layout, longData(), { maxPaperWidth: 58 }))
    expect(Math.max(...lines.map((l) => l.text.length * (l.large ? 2 : 1)))).toBeLessThanOrEqual(32)
    expect(lines.some((l) => l.text === '-'.repeat(32))).toBe(true)
    // a 58mm layout is not widened by an 80mm device
    const narrow = parse(receiptBytes({ paperWidth: 58, blocks: NEW_TEMPLATE_BLOCKS }, longData(), { maxPaperWidth: 80 }))
    expect(narrow.some((l) => l.text === '-'.repeat(32))).toBe(true)
  })
})
