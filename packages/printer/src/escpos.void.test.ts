import { describe, it, expect } from 'vitest'
import { buildReceipt, buildVoidSlip, voidSlipLines, COLS, type ReceiptData, type VoidSlipData } from './escpos'
import type { components } from '@mandalika/api'

type ReceiptSettings = components['schemas']['ReceiptSettings']

// Strip ESC/POS control sequences and return the printed text lines.
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
const settings = { headerText: 'TOKO', footerText: '', showTax: true } as ReceiptSettings
const base: ReceiptData = {
  orderRef: 'MND-2', pending: false, dateTime: new Date('2026-05-29T00:00:00Z'),
  lines: [{ name: 'Parfum', qty: 1, unitPrice: 100000, amount: 100000 }],
  subtotal: 100000, discountAmount: 0, taxAmount: 0, total: 80000,
  paymentLabel: 'Tunai', amountPaid: 80000, change: 0, customerName: null, customerPhone: null, cashierName: 'Kasir',
}
const voidData: VoidSlipData = {
  orderRef: 'MND-1', total: 100000, reasonLabel: 'Salah barang', voidedBy: 'Sari', dateTime: '14/11/2026 10:00', pending: false,
}

describe('DIBATALKAN slip', () => {
  it('void slip contains DIBATALKAN, No: #MND-1, Alasan: Salah barang', () => {
    const lines = slip(buildVoidSlip(voidData))
    expect(lines).toEqual([
      'DIBATALKAN', 'No: #MND-1', 'Total: 100.000', 'Alasan: Salah barang', 'Oleh: Sari', 'Waktu: 14/11/2026 10:00',
    ])
  })

  it('voidSlipLines fit 32 and 48 columns and print a note with é as e', () => {
    const d: VoidSlipData = {
      ...voidData, note: 'Pelanggan salah pilih parfum café dan minta ganti ukuran yang lain sekarang juga', replacementRef: 'MND-9',
    }
    for (const cols of [32, 48]) {
      const lines = voidSlipLines(d, cols)
      expect(lines.every((l) => l.length <= cols)).toBe(true)
      expect(lines.join('\n')).toContain('cafe')
      expect(lines.join('\n')).not.toContain('é')
      expect(lines).toContain('Pengganti: #MND-9')
    }
  })
})

describe('replacement receipt', () => {
  it('prints Pengganti untuk #MND-1 and a Penyesuaian koreksi row of -20.000', () => {
    const lines = slip(buildReceipt({ ...base, replacesOrderRef: 'MND-1', correctionAmount: -20000 }, settings))
    const i = lines.indexOf('Pengganti untuk #MND-1')
    expect(i).toBeGreaterThan(0)
    expect(lines[i + 1]).toMatch(/^No +MND-2$/)
    const c = lines.findIndex((l) => l.startsWith('Penyesuaian koreksi'))
    expect(lines[c]).toBe('Penyesuaian koreksi'.padEnd(COLS - '-20.000'.length) + '-20.000')
    expect(lines[c + 1]).toMatch(/^TOTAL +80\.000$/)
  })

  it('prints the correction on an itemised slip with every totals switch off; positive prints +20.000', () => {
    const off = { headerText: '', footerText: '', showSubtotal: false, showDiscount: false, showTax: false } as ReceiptSettings
    const lines = slip(buildReceipt({ ...base, discounts: [], correctionAmount: 20000, total: 120000 }, off))
    expect(lines.some((l) => l === 'Penyesuaian koreksi'.padEnd(COLS - '+20.000'.length) + '+20.000')).toBe(true)
  })

  it('a reprint prints Pengganti untuk under the top reprint mark; no field means no row', () => {
    const lines = slip(buildReceipt({ ...base, replacesOrderRef: 'MND-1' }, settings, true))
    const m = lines.findIndex((l) => l.includes('CETAK ULANG'))
    expect(lines[m + 1]).toBe('Pengganti untuk #MND-1')
    const plain = slip(buildReceipt(base, settings))
    expect(plain.some((l) => l.includes('Pengganti') || l.includes('koreksi'))).toBe(false)
  })

  it('a long ref wraps within 32 columns', () => {
    const lines = slip(buildReceipt({ ...base, replacesOrderRef: 'X'.repeat(60) }, settings))
    expect(lines.every((l) => l.length <= COLS)).toBe(true)
  })
})
