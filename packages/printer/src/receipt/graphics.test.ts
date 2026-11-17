import { describe, it, expect } from 'vitest'
import { COLS_BY_WIDTH, type ReceiptBlock, type ReceiptLayout } from './layout'
import { receiptBytes, receiptPreview } from './render'
import { ditherToRaster } from './raster'
import { NEW_TEMPLATE_BLOCKS, SAMPLE_RECEIPT } from './sample'

const rgba = (w: number, h: number): Uint8ClampedArray => {
  const a = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) a.set([i % 3 === 0 ? 0 : 255, 0, 0, 255], i * 4)
  return a
}
const LOGO = ditherToRaster(rgba(384, 150), 384, 150)
const URL = 'https://mandalikaperfume.co.id/ulasan?ref=' + 'x'.repeat(40)

const core: ReceiptBlock[] = [
  { id: 'i', type: 'items', enabled: true },
  { id: 'o', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
  { id: 'p', type: 'payment', enabled: true },
]
const layout = (extra: ReceiptBlock[], width: 58 | 80 = 58): ReceiptLayout => ({ paperWidth: width, blocks: [...extra, ...core] })
const image: ReceiptBlock = { id: 'img', type: 'image', enabled: true, image: LOGO, align: 'center' }
const qr: ReceiptBlock = { id: 'qr', type: 'qr', enabled: true, url: URL, align: 'center' }

function find(b: Uint8Array, seq: number[], from = 0): number {
  outer: for (let i = from; i <= b.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (b[i + j] !== seq[j]) continue outer
    return i
  }
  return -1
}

describe('graphics blocks', () => {
  it('image block emits GS v 0 bands of <= 64 rows with the right xL/yL', () => {
    const b = receiptBytes(layout([image]), SAMPLE_RECEIPT)
    const rowBytes = 384 / 8
    const heights: number[] = []
    let at = 0
    for (;;) {
      at = find(b, [0x1d, 0x76, 0x30, 0x00], at)
      if (at < 0) break
      expect(b[at + 4]).toBe(rowBytes)
      expect(b[at + 5]).toBe(0)
      heights.push(b[at + 6]! + 256 * b[at + 7]!)
      at += 8 + rowBytes * heights[heights.length - 1]!
    }
    expect(heights).toEqual([64, 64, 22])
  })

  it('qr block emits the GS ( k store command with pL/pH', () => {
    const b = receiptBytes(layout([qr]), SAMPLE_RECEIPT)
    const at = find(b, [0x1d, 0x28, 0x6b, URL.length + 3, 0x00, 0x31, 0x50, 0x30])
    expect(at).toBeGreaterThan(0)
    expect(find(b, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])).toBeGreaterThan(at)
  })

  it('graphics off: no GS v 0 or GS ( k bytes; the QR url prints as text within the width', () => {
    const l = layout([image, qr])
    const b = receiptBytes(l, SAMPLE_RECEIPT, { graphics: false })
    expect(find(b, [0x1d, 0x76, 0x30])).toBe(-1)
    expect(find(b, [0x1d, 0x28, 0x6b])).toBe(-1)
    expect(String.fromCharCode(...b)).toContain('https://mandalikaperfume.co.id')
    const preview = receiptPreview(l, SAMPLE_RECEIPT, { graphics: false })
    expect(preview.every((p) => p.kind === 'text' && p.text.length <= COLS_BY_WIDTH[58])).toBe(true)
  })

  it('a QR url over 300 chars prints as text and never throws', () => {
    const long = { ...qr, url: 'https://' + 'a'.repeat(400) } as ReceiptBlock
    const b = receiptBytes(layout([long]), SAMPLE_RECEIPT)
    expect(find(b, [0x1d, 0x28, 0x6b])).toBe(-1)
    expect(String.fromCharCode(...b)).toContain('https://aaaa')
  })

  it('a raster with a short data string is skipped, the rest prints', () => {
    const bad = { ...image, image: { width: 16, height: 2, data: btoa('abc') } } as ReceiptBlock
    const b = receiptBytes(layout([bad]), SAMPLE_RECEIPT)
    expect(find(b, [0x1d, 0x76, 0x30])).toBe(-1)
    expect(String.fromCharCode(...b)).toContain('TOTAL')
  })

  it('the reprint mark follows the leading logo', () => {
    const b = receiptBytes(layout([image]), SAMPLE_RECEIPT, { reprint: true })
    const mark = find(b, Array.from('CETAK ULANG', (c) => c.charCodeAt(0)))
    expect(mark).toBeGreaterThan(find(b, [0x1d, 0x76, 0x30]))
  })

  it('preview carries image and qr lines with the alignment', () => {
    const p = receiptPreview(layout([image, qr]), SAMPLE_RECEIPT)
    expect(p.find((l) => l.kind === 'image')).toMatchObject({ kind: 'image', align: 'center' })
    expect(p.find((l) => l.kind === 'qr')).toMatchObject({ kind: 'qr', data: URL, align: 'center' })
  })

  it('text parts stay within the width with image and qr blocks at 32 and 48', () => {
    for (const w of [58, 80] as const) {
      const p = receiptPreview({ paperWidth: w, blocks: [image, qr, ...NEW_TEMPLATE_BLOCKS] }, SAMPLE_RECEIPT, { graphics: false })
      for (const l of p) if (l.kind === 'text') expect(l.text.length * (l.large ? 2 : 1)).toBeLessThanOrEqual(COLS_BY_WIDTH[w])
    }
  })
})
