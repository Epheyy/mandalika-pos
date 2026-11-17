import { describe, it, expect } from 'vitest'
import { NEW_TEMPLATE_BLOCKS, SAMPLE_RECEIPT } from './sample'
import type { ReceiptBlock, ReceiptLayout } from './layout'
import { receiptPreview } from './render'
import type { PreviewLine } from './sink'
import { RECEIPT_LIMITS, validateTemplate } from './validate'
import { DATA_CASES } from './fixtures'

type TextLine = Extract<PreviewLine, { kind: 'text' }>
const textLines = (layout: ReceiptLayout, data = SAMPLE_RECEIPT): TextLine[] =>
  receiptPreview(layout, data).filter((l): l is TextLine => l.kind === 'text')
const texts = (layout: ReceiptLayout, data = SAMPLE_RECEIPT): string[] => textLines(layout, data).map((l) => l.text)
const newLayout = (blocks: ReceiptBlock[] = NEW_TEMPLATE_BLOCKS, paperWidth: 58 | 80 = 58): ReceiptLayout => ({ paperWidth, blocks })

describe('designer blocks', () => {
  it('points block is absent without data.points and prints both rows with it', () => {
    const { points: _omit, ...without } = SAMPLE_RECEIPT
    void _omit
    expect(texts(newLayout(), without).some((t) => t.includes('Perkiraan'))).toBe(false)
    const rows = texts(newLayout())
    expect(rows.find((t) => t.startsWith('Perkiraan poin'))?.endsWith('+80')).toBe(true)
    expect(rows.find((t) => t.startsWith('Perkiraan saldo'))?.endsWith('1.240')).toBe(true)
    const noBalance = texts(newLayout(), { ...SAMPLE_RECEIPT, points: { earned: 80, balance: null } })
    expect(noBalance.some((t) => t.startsWith('Perkiraan saldo'))).toBe(false)
    expect(noBalance.some((t) => t.startsWith('Perkiraan poin'))).toBe(true)
  })

  it('itemised slip prints every deduction and PPN even when the totals switches are off', () => {
    const blocks = NEW_TEMPLATE_BLOCKS.map((b) => (b.type === 'totals' ? { ...b, showSubtotal: false, showDiscount: false, showTax: false } : b))
    const rows = texts(newLayout(blocks), DATA_CASES.itemised!)
    expect(rows.some((t) => t.includes('Promo Gajian'))).toBe(true)
    expect(rows.some((t) => t.startsWith('PPN'))).toBe(true)
    expect(rows.some((t) => t.startsWith('Tukar poin'))).toBe(true)
    expect(rows.some((t) => t.startsWith('Pembulatan'))).toBe(true)
    expect(rows.some((t) => t.startsWith('Subtotal'))).toBe(false)
    // and the void correction row, whatever the switches say
    expect(texts(newLayout(blocks), DATA_CASES.replacement!).some((t) => t.startsWith('Penyesuaian koreksi'))).toBe(true)
  })

  it('header prints outlet name, address and phone centred', () => {
    const lines = textLines(newLayout(), SAMPLE_RECEIPT)
    for (const part of ['Outlet Grand Indonesia', 'Jl. M.H. Thamrin', '021-5551234']) {
      const l = lines.find((x) => x.text.includes(part))
      expect(l?.align, part).toBe('center')
    }
  })

  it("a non-compat layout prints 'Cafe' for 'Café', normalised before layout", () => {
    const rows = texts(newLayout(), { ...SAMPLE_RECEIPT, customerName: 'Café Bunga', lines: [{ name: 'Café “X”', qty: 1, unitPrice: 1000, amount: 1000 }] })
    expect(rows.some((t) => t.includes('Cafe Bunga'))).toBe(true)
    expect(rows.some((t) => t.includes('Cafe "X"'))).toBe(true)
    expect(rows.some((t) => t.includes('é'))).toBe(false)
  })

  it('a new template prints Kembalian whenever change > 0 (payment has no switch)', () => {
    const withChange = texts(newLayout(), { ...SAMPLE_RECEIPT, amountPaid: 850000, change: 50000 })
    expect(withChange.find((t) => t.startsWith('Kembalian'))?.endsWith('50.000')).toBe(true)
    expect(texts(newLayout(), SAMPLE_RECEIPT).some((t) => t.startsWith('Kembalian'))).toBe(false)
    // a stray showChange:false is ignored outside Standar
    const stray = NEW_TEMPLATE_BLOCKS.map((b) => (b.type === 'payment' ? { ...b, showChange: false } : b))
    expect(texts(newLayout(stray), { ...SAMPLE_RECEIPT, change: 50000 }).some((t) => t.startsWith('Kembalian'))).toBe(true)
  })

  it('text block honours align, bold and large and wraps at half width when large', () => {
    const blocks = [...NEW_TEMPLATE_BLOCKS.slice(0, -1),
      { id: 'big', type: 'text', enabled: true, text: 'x'.repeat(40), align: 'right', bold: true, size: 'large' } as ReceiptBlock]
    const big = textLines(newLayout(blocks), SAMPLE_RECEIPT).filter((l) => l.large && l.text.startsWith('xx'))
    expect(big.map((l) => l.text.length)).toEqual([16, 16, 8])
    expect(big[0]).toMatchObject({ align: 'right', bold: true, large: true })
  })

  it('the reprint mark and replacement mark print after the header run', () => {
    const rows = texts(newLayout(), { ...SAMPLE_RECEIPT, replacesOrderRef: 'MND-1' })
    expect(rows.filter((t) => t === '*** CETAK ULANG (REPRINT) ***')).toHaveLength(0)
    const rp = receiptPreview(newLayout(), { ...SAMPLE_RECEIPT, replacesOrderRef: 'MND-1' }, { reprint: true }).map((l) => l.text)
    expect(rp.filter((t) => t === '*** CETAK ULANG (REPRINT) ***')).toHaveLength(2)
    expect(rp.indexOf('Pengganti untuk #MND-1')).toBe(rp.indexOf('*** CETAK ULANG (REPRINT) ***') + 1)
  })
})

describe('bad data', () => {
  it('null/undefined text fields print as empty instead of throwing', () => {
    const bad = { ...SAMPLE_RECEIPT, outlet: { name: null as unknown as string }, lines: [{ name: undefined as unknown as string, qty: 1, unitPrice: 1, amount: 1 }] }
    expect(() => receiptPreview(newLayout(), bad)).not.toThrow()
  })
  it('the shared samples are frozen', () => {
    expect(Object.isFrozen(NEW_TEMPLATE_BLOCKS)).toBe(true)
    expect(Object.isFrozen(NEW_TEMPLATE_BLOCKS[0])).toBe(true)
    expect(Object.isFrozen(SAMPLE_RECEIPT.lines[0])).toBe(true)
  })
  it('validateTemplate survives a null block and a missing name', () => {
    expect(() => validateTemplate({ name: undefined as unknown as string, paperWidth: 58, blocks: [null as unknown as ReceiptBlock] })).not.toThrow()
  })
})

describe('validateTemplate', () => {
  const ok = { name: 'Struk', paperWidth: 58, blocks: NEW_TEMPLATE_BLOCKS }
  it('accepts the new-template blocks', () => {
    expect(validateTemplate(ok)).toEqual([])
  })

  it('reports locked_missing, locked_order and too_many_blocks', () => {
    const noItems = validateTemplate({ ...ok, blocks: NEW_TEMPLATE_BLOCKS.filter((b) => b.type !== 'items') })
    expect(noItems.map((i) => i.code)).toContain('locked_missing')
    const swap = [...NEW_TEMPLATE_BLOCKS]
    const t = swap.findIndex((b) => b.type === 'totals'); const p = swap.findIndex((b) => b.type === 'payment')
    ;[swap[t], swap[p]] = [swap[p]!, swap[t]!]
    expect(validateTemplate({ ...ok, blocks: swap }).map((i) => i.code)).toContain('locked_order')
    const many = [...NEW_TEMPLATE_BLOCKS, ...Array.from({ length: 21 }, (_, i) => ({ id: `d${i}`, type: 'divider', enabled: true }) as ReceiptBlock)]
    expect(validateTemplate({ ...ok, blocks: many })[0]!.code).toBe('too_many_blocks')
  })

  it('reports template-level issues before block issues, in a fixed order', () => {
    const bad = validateTemplate({
      name: '',
      paperWidth: 58,
      blocks: [{ id: 'a', type: 'text', enabled: true, text: 'café', align: 'left', bold: false, size: 'normal', label: 'L'.repeat(41) }],
    })
    expect(bad.map((i) => i.code)).toEqual([
      'name_invalid', 'too_few_blocks', 'locked_missing', 'locked_missing', 'locked_missing', 'not_printable', 'label_too_long',
    ])
  })

  it('flags limits and compat-only fields', () => {
    const long = NEW_TEMPLATE_BLOCKS.map((b) => (b.id === 'thanks' && b.type === 'text' ? { ...b, text: 'a'.repeat(RECEIPT_LIMITS.textMax + 1) } : b))
    expect(validateTemplate({ ...ok, blocks: long }).map((i) => i.code)).toContain('text_too_long')
    const lines = NEW_TEMPLATE_BLOCKS.map((b) => (b.id === 'thanks' && b.type === 'text' ? { ...b, text: Array(13).fill('a').join('\n') } : b))
    expect(validateTemplate({ ...ok, blocks: lines }).map((i) => i.code)).toContain('too_many_lines')
    const compat = NEW_TEMPLATE_BLOCKS.map((b) => (b.type === 'payment' ? { ...b, showChange: true } : b))
    expect(validateTemplate({ ...ok, blocks: compat })).toEqual([expect.objectContaining({ code: 'compat_field', blockId: 'payment' })])
  })
})
