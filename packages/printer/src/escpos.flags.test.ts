import { describe, it, expect } from 'vitest'
import { resolveReceiptFlags } from '@mandalika/types'
import { buildReceipt, type ReceiptData } from './escpos'
import type { components } from '@mandalika/api'

type ReceiptSettings = components['schemas']['ReceiptSettings']

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

// Pre-C1 shape (no `discounts`) so the discount and tax toggles govern their rows.
const data: ReceiptData = {
  orderRef: 'T1', pending: false, dateTime: new Date('2026-05-29T00:00:00Z'),
  lines: [{ name: 'Oud', variant: '', qty: 1, unitPrice: 100000, amount: 100000 }],
  subtotal: 100000, discountAmount: 10000, taxAmount: 9900, total: 99900,
  paymentLabel: 'Tunai', amountPaid: 150000, change: 50100,
  customerName: 'Sari', customerPhone: '0812', cashierName: 'Dewi',
}

// key -> [what the paper prints for it, what an absent/null key means]
const ROWS = {
  showOrderNumber: ['No ', true],
  showCashier: ['Kasir:', false],
  showCustomerName: ['Pelanggan:', true],
  showCustomerPhone: ['Telp:', false],
  showTax: ['PPN', false],
  showDiscount: ['Diskon', true],
  showSubtotal: ['Subtotal', true],
  showChange: ['Kembalian', true],
} as const

const KEYS = Object.keys(ROWS) as (keyof typeof ROWS)[]
const STATES = ['absent', 'null', 'false', 'true'] as const
const settingsFor = (k: keyof typeof ROWS, st: (typeof STATES)[number]) =>
  ({ headerText: '', footerText: '', ...(st === 'absent' ? {} : { [k]: st === 'null' ? null : st === 'true' }) }) as unknown as ReceiptSettings
const expected = (k: keyof typeof ROWS, st: (typeof STATES)[number]) => (st === 'true' ? true : st === 'false' ? false : ROWS[k][1])

describe('F35 receipt flags on the printer', () => {
  for (const k of KEYS) {
    for (const st of STATES) {
      it(`${k} ${st}: the row is ${expected(k, st) ? 'printed' : 'hidden'}`, () => {
        const lines = slip(buildReceipt(data, settingsFor(k, st)))
        expect(lines.some((l) => l.startsWith(ROWS[k][0]))).toBe(expected(k, st))
        // The resolver reads the same flag the same way.
        expect(resolveReceiptFlags(settingsFor(k, st) as never)[k]).toBe(expected(k, st))
      })
    }
  }

  it('hiding one flag drops only that row and leaves order amounts alone', () => {
    const base = slip(buildReceipt(data, settingsFor('showChange', 'true')))
    const off = slip(buildReceipt(data, settingsFor('showChange', 'false')))
    expect(base.filter((l) => !l.startsWith('Kembalian'))).toEqual(off)
    expect(off.find((l) => l.startsWith('TOTAL'))).toMatch(/99\.900$/)
    expect(data.change).toBe(50100)
  })

  it('an itemised (C1) slip keeps its discount and PPN rows whatever the toggles say', () => {
    const c1: ReceiptData = { ...data, discounts: [{ label: 'Promo', amount: 10000 }] }
    const lines = slip(buildReceipt(c1, { headerText: '', footerText: '', showDiscount: false, showTax: false } as unknown as ReceiptSettings))
    expect(lines.some((l) => l.includes('Promo'))).toBe(true)
    expect(lines.some((l) => l.startsWith('PPN'))).toBe(true)
  })
})
