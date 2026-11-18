import { describe, expect, it } from 'vitest'
import { buildVoidSlip } from '../escpos'
import { VOID_SLIP } from './fixtures'
import { type ReceiptBlock, type ReceiptLayout } from './layout'
import { ditherToRaster } from './raster'
import { standarLayout } from './standar'
import { refundSlipBytes, voidSlipBytes, voidSlipLines, type RefundSlipData } from './slips'

/** Printable bytes as characters, LF as a newline, every other byte as U+0001. */
const text = (b: Uint8Array): string => Array.from(b, (x) => (x === 0x0a ? '\n' : x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '\u0001')).join('')
const find = (b: Uint8Array, seq: number[], from = 0): number => {
  outer: for (let i = from; i <= b.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (b[i + j] !== seq[j]) continue outer
    return i
  }
  return -1
}
const GS_V0 = [0x1d, 0x76, 0x30]
const GS_PAREN_K = [0x1d, 0x28, 0x6b]

const rgba = (w: number, h: number): Uint8ClampedArray => {
  const a = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) a.set([i % 3 === 0 ? 0 : 255, 0, 0, 255], i * 4)
  return a
}
const LOGO = ditherToRaster(rgba(384, 100), 384, 100)
const core: ReceiptBlock[] = [
  { id: 'i', type: 'items', enabled: true },
  { id: 'o', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
  { id: 'p', type: 'payment', enabled: true },
]
const templ = (width: 58 | 80 = 58): ReceiptLayout => ({
  paperWidth: width,
  blocks: [
    { id: 'img', type: 'image', enabled: true, image: LOGO, align: 'center' },
    { id: 'h', type: 'header', enabled: true, text: 'MANDALIKA', size: 'normal', showOutletName: true, showOutletAddress: true, showOutletPhone: false },
    ...core,
  ],
})
const settings = { copies: 1, headerText: 'TOKO MANDALIKA', footerText: '', showTax: true } as Parameters<typeof standarLayout>[0]
const outlet = { name: 'Mandalika BSD', address: 'Jl. BSD Raya 1', phone: null }

const refund = (over: Partial<RefundSlipData> = {}): RefundSlipData => ({
  orderRef: 'MND-100', dateTime: new Date('2026-05-29T03:04:00Z'),
  lines: [
    { name: 'Parfum Bunga', variant: '50ml', qty: 1, amount: 150000 },
    { name: 'Parfum Melati Yang Namanya Panjang Sekali Sampai Kepotong', qty: 2, amount: 90000 },
  ],
  total: 240000, payoutLabel: 'Tunai', reasonLabel: 'Rusak/cacat', cashierName: 'Sari', ...over,
})

describe('voidSlipBytes', () => {
  it("with Standar's layout prints the header text, DIBATALKAN, then Void's body lines in buildVoidSlip's order", () => {
    const out = text(voidSlipBytes(standarLayout(settings), VOID_SLIP))
    const head = out.indexOf('TOKO MANDALIKA')
    const stamp = out.indexOf('DIBATALKAN')
    expect(head).toBeGreaterThanOrEqual(0)
    expect(stamp).toBeGreaterThan(head)
    let at = stamp
    for (const l of voidSlipLines(VOID_SLIP, 32)) {
      const i = out.indexOf(l, at)
      expect(i, l).toBeGreaterThanOrEqual(at)
      at = i
    }
    // buildVoidSlip prints the same body lines, so the framed slip ends with exactly its body.
    const plain = text(buildVoidSlip(VOID_SLIP))
    const body = voidSlipLines(VOID_SLIP, 32).join('\n')
    expect(plain).toContain(body)
    expect(out).toContain(body)
  })

  it('with a template prints the logo/header blocks, then DIBATALKAN, then the body', () => {
    const b = voidSlipBytes(templ(), { ...VOID_SLIP, outlet })
    const out = text(b)
    expect(find(b, GS_V0)).toBeGreaterThanOrEqual(0)
    expect(out.indexOf('Mandalika BSD')).toBeGreaterThan(out.indexOf('MANDALIKA'))
    expect(out.indexOf('DIBATALKAN')).toBeGreaterThan(out.indexOf('Jl. BSD Raya 1'))
    expect(out.indexOf('No: #MND-100')).toBeGreaterThan(out.indexOf('DIBATALKAN'))
  })

  it('graphics off sends no GS v 0 / GS ( k bytes but keeps the header text', () => {
    const b = voidSlipBytes(templ(), { ...VOID_SLIP, outlet }, { graphics: false })
    expect(find(b, GS_V0)).toBe(-1)
    expect(find(b, GS_PAREN_K)).toBe(-1)
    expect(text(b)).toContain('MANDALIKA')
  })

  it('ends with feed and cut, and a wide template renders at the device paper width', () => {
    const b = voidSlipBytes(templ(80), { ...VOID_SLIP, note: 'x'.repeat(60) }, { maxPaperWidth: 58, graphics: false })
    expect(Array.from(b.slice(-7))).toEqual([0x1b, 0x64, 0x03, 0x1d, 0x56, 0x42, 0x00])
    for (const l of text(b).split('\n')) if (l.startsWith('Catatan') || l.startsWith('x')) expect(l.length).toBeLessThanOrEqual(32)
  })

  it('a header block that fails is skipped and reported; the slip still prints', () => {
    const o = { name: 'N', phone: null } as unknown as NonNullable<typeof outlet>
    Object.defineProperty(o, 'address', { get() { throw new Error('boom') } })
    const errs: string[] = []
    const out = text(voidSlipBytes(templ(), { ...VOID_SLIP, outlet: o }, { graphics: false, onBlockError: (id) => errs.push(id) }))
    expect(errs).toEqual(['outlet'])
    expect(out).toContain('DIBATALKAN')
    expect(out).toContain('No: #MND-100')
  })
})

describe('slip frame', () => {
  it('skips a disabled block ahead of the logo and header, like the sale receipt', () => {
    const lay: ReceiptLayout = { paperWidth: 58, blocks: [{ id: 't', type: 'text', enabled: false, text: 'x', align: 'center', size: 'normal', bold: false }, ...templ().blocks] as ReceiptBlock[] }
    const b = voidSlipBytes(lay, VOID_SLIP, { graphics: true })
    expect(find(b, GS_V0)).toBeGreaterThan(-1)
    expect(text(b)).toContain('MANDALIKA')
  })

  it('a newline in the outlet address does not reach the printer as a line break', () => {
    const out = text(voidSlipBytes(templ(), { ...VOID_SLIP, outlet: { name: 'BSD', address: 'Jl. A\nTangerang', phone: null } }, { graphics: false }))
    expect(out).toContain('Jl. A Tangerang')
  })
})

describe('refundSlipBytes', () => {
  for (const [w, cols] of [[58, 32], [80, 48]] as const) {
    it(`refund slip lines add up to TOTAL REFUND and fit ${cols} columns`, () => {
      const d = refund()
      expect(d.lines.reduce((n, l) => n + l.amount, 0)).toBe(d.total)
      const out = text(refundSlipBytes(templ(w), d, { graphics: false }))
      expect(out).toContain('TOTAL REFUND')
      expect(out).toContain('240.000')
      expect(out).toContain('Dikembalikan lewat Tunai')
      expect(out).toContain('Alasan: Rusak/cacat')
      expect(out).toContain('Kasir: Sari')
      expect(out).toContain('No: #MND-100')
      expect(out).toMatch(/1 x Parfum Bunga 50ml\s+150\.000/)
      const rows = out.split('\n').filter((l) => /^(\d+ x |\s+\d|[A-Z][a-z]+ |TOTAL|Dikembalikan|Alasan|Kasir|No:|Tgl:)/.test(l) && !l.includes('\u0001'))
      expect(rows.length).toBeGreaterThan(6)
      for (const l of rows) expect(l.length, l).toBeLessThanOrEqual(cols)
    })
  }

  it('omits the Alasan row without a reason and wraps a long payout label', () => {
    const out = text(refundSlipBytes(standarLayout(settings), refund({ reasonLabel: undefined, payoutLabel: 'Kartu Debit BCA Sangat Panjang Sekali Namanya Lho' })))
    expect(out).not.toContain('Alasan:')
    const i = out.indexOf('Dikembalikan lewat')
    const label = out.slice(i, out.indexOf('Kasir:')).split('\n').filter(Boolean)
    expect(label.length).toBeGreaterThan(1)
    for (const l of label) expect(l.length).toBeLessThanOrEqual(32)
  })

  it('stamp line is centred, bold, large', () => {
    const b = refundSlipBytes(standarLayout(settings), refund())
    const intro = [0x1b, 0x61, 0x01, 0x1b, 0x45, 0x01, 0x1d, 0x21, 0x11]
    // The Standar header uses the same bold-large-centred run; the stamp is the one that spells REFUND.
    let stamp = -1
    for (let from = 0; (from = find(b, intro, from)) >= 0; from++) {
      if (String.fromCharCode(...b.slice(from + 9, from + 15)) === 'REFUND') { stamp = from; break }
    }
    expect(stamp).toBeGreaterThan(-1)
    expect(find(b, [0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00], stamp)).toBe(stamp + 9 + 7)
  })

  it('graphics off sends no GS v 0 / GS ( k bytes; on, the template logo prints', () => {
    const off = refundSlipBytes(templ(), { ...refund(), outlet }, { graphics: false })
    expect(find(off, GS_V0)).toBe(-1)
    expect(find(off, GS_PAREN_K)).toBe(-1)
    expect(find(refundSlipBytes(templ(), refund(), { graphics: true }), GS_V0)).toBeGreaterThan(-1)
  })

  it('prints a signed Penyesuaian row under the lines so lines + adjustment = TOTAL REFUND', () => {
    const d = refund({ lines: [{ name: 'A', qty: 1, amount: 100000 }, { name: 'B', qty: 1, amount: 20000 }], total: 70000, adjustment: { label: 'Penyesuaian', amount: -50000 } })
    const out = text(refundSlipBytes(standarLayout(settings), d))
    expect(out).toMatch(/Penyesuaian\s+-50\.000/)
    expect(out).toMatch(/1 x B\s+20\.000/)
    expect(out.indexOf('Penyesuaian')).toBeGreaterThan(out.indexOf('1 x B'))
    expect(out.indexOf('Penyesuaian')).toBeLessThan(out.indexOf('TOTAL REFUND'))
  })

  it('folds accents and control characters in names', () => {
    const out = text(refundSlipBytes(standarLayout(settings), refund({ lines: [{ name: 'Café\nNoir·X', qty: 1, amount: 240000 }] })))
    expect(out).toContain('1 x Cafe Noir')
  })
})
