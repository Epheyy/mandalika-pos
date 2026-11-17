import { describe, expect, it } from 'vitest'
import { layoutFromApi } from './fromApi'
import { COLS_BY_WIDTH, type ReceiptLayout } from './layout'
import { receiptPreview } from './render'
import { NEW_TEMPLATE_BLOCKS, SAMPLE_RECEIPT } from './sample'

const core = () => [
  { id: 'i', type: 'items', enabled: true },
  { id: 'o', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
  { id: 'p', type: 'payment', enabled: true },
]
const tpl = (blocks: unknown[], paperWidth: unknown = 58) => ({ id: 'x', version: 1, paperWidth, blocks })

describe('layoutFromApi', () => {
  it('builds a layout from a valid template and never marks it compat', () => {
    const l = layoutFromApi(tpl([{ id: 'h', type: 'header', enabled: true, text: 'TOKO', size: 'large', showOutletName: true, showOutletAddress: false, showOutletPhone: false, spaceAfter: true }, ...core()]))
    expect(l?.paperWidth).toBe(58)
    expect(l?.compat).toBeUndefined()
    expect(l?.blocks.map((b) => b.type)).toEqual(['header', 'items', 'totals', 'payment'])
    expect(JSON.stringify(l)).not.toContain('spaceAfter') // Standar-only fields are never read from a template
  })

  it('returns null when payment is missing, so the tablet prints Standar', () => {
    expect(layoutFromApi(tpl(core().slice(0, 2)))).toBeNull()
  })

  it.each([
    ['a disabled locked block', [{ id: 'i', type: 'items', enabled: false }, core()[1], core()[2]]],
    ['locked blocks out of order', [core()[1], core()[0], core()[2]]],
    ['a locked block with an ill-typed field', [core()[0], { ...core()[1], showTax: 'yes' }, core()[2]]],
    ['a duplicated locked block', [...core(), { id: 'i2', type: 'items', enabled: true }]],
  ])('returns null for %s', (_n, blocks) => {
    expect(layoutFromApi(tpl(blocks))).toBeNull()
  })

  it.each([[undefined], [null], ['x'], [{}], [tpl(core(), 70)], [tpl(core(), '58')], [{ paperWidth: 58 }]])('returns null for junk %#', (t) => {
    expect(layoutFromApi(t)).toBeNull()
  })

  it('drops an unknown block type and keeps the rest', () => {
    const l = layoutFromApi(tpl([{ id: 'q', type: 'qr', enabled: true, url: 'https://x.test' }, ...core()]))
    expect(l?.blocks.map((b) => b.id)).toEqual(['i', 'o', 'p'])
  })

  it('drops an unlocked block with an ill-typed field and keeps the rest', () => {
    const l = layoutFromApi(tpl([{ id: 't', type: 'text', enabled: true, text: 5, align: 'center', bold: false, size: 'normal' }, ...core()]))
    expect(l?.blocks.map((b) => b.id)).toEqual(['i', 'o', 'p'])
  })

  it('drops a block with an unknown enum value', () => {
    const l = layoutFromApi(tpl([{ id: 't', type: 'text', enabled: true, text: 'a', align: 'justify' }, ...core()]))
    expect(l?.blocks.map((b) => b.id)).toEqual(['i', 'o', 'p'])
  })

  it('fills the defaults of omitted optional fields', () => {
    const l = layoutFromApi(tpl([{ id: 't', type: 'text', enabled: true }, { id: 'h', type: 'header', enabled: true }, { id: 'x', type: 'transaction', enabled: true }, ...core().slice(0, 1), { id: 'o', type: 'totals', enabled: true }, core()[2]]))
    expect(l?.blocks[0]).toEqual({ id: 't', type: 'text', enabled: true, text: '', align: 'left', bold: false, size: 'normal' })
    expect(l?.blocks[3]).toMatchObject({ type: 'items' })
    expect(l?.blocks[4]).toMatchObject({ type: 'totals', showSubtotal: true, showDiscount: true, showTax: true })
  })

  it('renders a 48-column template at 32 columns when the device width is 58', () => {
    const l = layoutFromApi({ id: 'x', version: 1, paperWidth: 80, blocks: JSON.parse(JSON.stringify(NEW_TEMPLATE_BLOCKS)) }) as ReceiptLayout
    expect(l.paperWidth).toBe(80)
    const wide = receiptPreview(l, SAMPLE_RECEIPT, { maxPaperWidth: 80 })
    const narrow = receiptPreview(l, SAMPLE_RECEIPT, { maxPaperWidth: 58 })
    const width = (lines: typeof wide) => Math.max(...lines.map((p) => (p.kind === 'text' ? p.text.length * (p.large ? 2 : 1) : 0)))
    expect(width(narrow)).toBeLessThanOrEqual(COLS_BY_WIDTH[58])
    expect(width(wide)).toBeGreaterThan(COLS_BY_WIDTH[58])
    expect(width(wide)).toBeLessThanOrEqual(COLS_BY_WIDTH[80])
  })
})
