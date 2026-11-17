import { describe, it, expect } from 'vitest'
import {
  SAMPLE_RECEIPT, receiptPreview, standarLayout, validateTemplate, type ReceiptBlock,
} from '@mandalika/printer/render'
import { designerReducer, fromCompat, toBody, type DesignerState } from './designerReducer'

const settings = { copies: 1, headerText: 'Toko Kita', footerText: 'Terima kasih' } as never
const virtual = (s: unknown = settings): DesignerState =>
  designerReducer({} as DesignerState, { type: 'loadVirtualStandar', settings: s as never })
const fresh = (): DesignerState =>
  designerReducer(virtual(), { type: 'newTemplate', name: 'Baru', paperWidth: 58 })
const idx = (s: DesignerState, type: string): number => s.layout.blocks.findIndex((b) => b.type === type)
const COMPAT_KEYS = ['compat', 'spaceAfter', 'spaceBefore', 'showChange']

describe('designerReducer', () => {
  it('toggle and remove are refused for items, totals and payment', () => {
    const s = fresh()
    for (const type of ['items', 'totals', 'payment']) {
      const id = s.layout.blocks[idx(s, type)]!.id
      expect(designerReducer(s, { type: 'toggle', id })).toBe(s)
      expect(designerReducer(s, { type: 'remove', id })).toBe(s)
    }
  })

  it('move that puts totals above items is refused', () => {
    const s = fresh()
    expect(designerReducer(s, { type: 'move', from: idx(s, 'totals'), to: idx(s, 'items') })).toBe(s)
  })

  it('move of a text block between totals and payment is allowed', () => {
    const s = fresh()
    const from = idx(s, 'text')
    const to = idx(s, 'totals') + 1
    const next = designerReducer(s, { type: 'move', from, to })
    expect(next).not.toBe(s)
    expect(idx(next, 'totals')).toBeLessThan(idx(next, 'text'))
    expect(idx(next, 'text')).toBeLessThan(idx(next, 'payment'))
    expect(next.dirty).toBe(true)
  })

  it("edit of text stores 'Cafe' for 'Café'", () => {
    const s = fresh()
    const id = s.layout.blocks[idx(s, 'text')]!.id
    const next = designerReducer(s, { type: 'edit', id, patch: { text: 'Café' } as Partial<ReceiptBlock> })
    expect((next.layout.blocks[idx(next, 'text')] as { text: string }).text).toBe('Cafe')
  })

  it('unedited virtual Standar keeps compat and previews the header and footer the tablet prints', () => {
    const s = virtual()
    expect(s.layout.compat).toBe('v1')
    expect(s.layout).toEqual(standarLayout(settings))
    const text = receiptPreview(s.layout, SAMPLE_RECEIPT).flatMap((l) => (l.kind === 'text' ? [l.text] : [])).join('\n')
    expect(text).toContain('Toko Kita')
    expect(text).toContain('Terima kasih')
    expect(text).toContain('CHAMPION')
  })

  it('the first edit drops compat; toBody never sends compat, spaceAfter, spaceBefore or showChange', () => {
    const s = virtual({ ...(settings as object), showChange: false })
    const next = designerReducer(s, { type: 'setWidth', paperWidth: 80 })
    expect(next.layout.compat).toBeUndefined()
    for (const k of COMPAT_KEYS) expect(JSON.stringify(toBody(next))).not.toContain(k)
    for (const k of COMPAT_KEYS) expect(JSON.stringify(toBody(s))).not.toContain(k)
    expect(next.adjustments.some((a) => a.kind === 'change_locked')).toBe(true)
  })

  it('fromCompat normalises é and clips a 700-char, 20-line footer to 500 chars and 12 lines, reporting both adjustments', () => {
    const footer = Array.from({ length: 20 }, () => 'é'.repeat(45)).join('\n')
    expect(footer.length).toBeGreaterThan(600)
    const { layout, adjustments } = fromCompat(standarLayout({ headerText: 'Café', footerText: footer } as never))
    const text = layout.blocks.find((b) => b.type === 'text') as { text: string }
    expect(text.text.split('\n').length).toBeLessThanOrEqual(12)
    expect([...text.text].length).toBeLessThanOrEqual(500)
    expect(text.text).not.toContain('é')
    const kinds = adjustments.map((a) => a.kind)
    expect(kinds).toContain('replaced_chars')
    expect(kinds).toContain('clipped_lines')
    expect(kinds).toContain('clipped_chars')
    expect(validateTemplate({ name: 'x', paperWidth: 58, blocks: layout.blocks })).toEqual([])
  })

  it('toBody sends isDefault only for the unsaved Standar', () => {
    expect(toBody(virtual()).isDefault).toBe(true)
    expect(toBody(virtual()).version).toBeUndefined()
    expect(toBody(fresh()).isDefault).toBeUndefined()
    const saved = designerReducer(fresh(), {
      type: 'load',
      template: { id: 'a', name: 'T', paperWidth: 58, blocks: fresh().layout.blocks, isDefault: true, version: 3, outletIds: [], updatedAt: '' } as never,
    })
    const body = toBody(saved)
    expect(body.isDefault).toBeUndefined()
    expect(body.version).toBe(3)
  })

  it('duplicate gives templateId null, isDefault false and a new name', () => {
    const next = designerReducer(virtual(), { type: 'duplicate', name: 'Standar (salinan)' })
    expect(next.templateId).toBeNull()
    expect(next.isDefault).toBe(false)
    expect(next.name).toBe('Standar (salinan)')
    expect(next.version).toBeNull()
    expect(next.layout.compat).toBeUndefined()
  })

  it('add gives unique ids and respects the 30 block cap', () => {
    let s = fresh()
    s = designerReducer(s, { type: 'add', block: 'text' })
    s = designerReducer(s, { type: 'add', block: 'text' })
    const ids = s.layout.blocks.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    while (s.layout.blocks.length < 30) s = designerReducer(s, { type: 'add', block: 'divider' })
    expect(designerReducer(s, { type: 'add', block: 'divider' })).toBe(s)
  })

  it('a new template does not mutate the shared starting blocks', () => {
    designerReducer(fresh(), { type: 'edit', id: 'thanks', patch: { text: 'Hai' } as Partial<ReceiptBlock> })
    expect((fresh().layout.blocks.find((b) => b.id === 'thanks') as { text: string }).text).toBe('Terima kasih!')
  })

  it('a template the tablet would refuse still opens for repair', () => {
    const blocks = fresh().layout.blocks.filter((b) => b.type !== 'payment')
    const s = designerReducer(fresh(), {
      type: 'load', template: { id: 'a', name: 'T', paperWidth: 58, blocks, isDefault: false, version: 1, outletIds: [], updatedAt: '' } as never,
    })
    expect(s.layout.blocks).toHaveLength(blocks.length)
  })
})

describe('image and QR blocks', () => {
  const count = (s: DesignerState, type: string) => s.layout.blocks.filter((b) => b.type === type).length

  it('adding an image starts as a valid blank raster and opens its editor', () => {
    const s = designerReducer(fresh(), { type: 'add', block: 'image' })
    const b = s.layout.blocks[0]!
    expect(b.type).toBe('image')
    expect(s.editingId).toBe(b.id)
    expect(s.dirty).toBe(true)
    expect(validateTemplate({ name: 'x', paperWidth: 58, blocks: s.layout.blocks })).toEqual([])
  })

  it('a new Logo goes to the top of the list and a QR appends at the end', () => {
    const base = fresh()
    const withLogo = designerReducer(base, { type: 'add', block: 'image' })
    expect(withLogo.layout.blocks[0]!.type).toBe('image')
    expect(withLogo.layout.blocks.slice(1).map((b) => b.id)).toEqual(base.layout.blocks.map((b) => b.id))
    const withQr = designerReducer(withLogo, { type: 'add', block: 'qr' })
    expect(withQr.layout.blocks.at(-1)!.type).toBe('qr')
    expect(withQr.layout.blocks[0]!.type).toBe('image')
    const second = designerReducer(withQr, { type: 'add', block: 'image' })
    expect(second.layout.blocks.slice(0, 2).map((b) => b.type)).toEqual(['image', 'image'])
  })

  it('adding a QR block uses a placeholder address that validates', () => {
    const s = designerReducer(fresh(), { type: 'add', block: 'qr' })
    const b = s.layout.blocks.at(-1)!
    expect(b).toMatchObject({ type: 'qr', url: 'https://example.com', align: 'center', enabled: true })
    expect(validateTemplate({ name: 'x', paperWidth: 58, blocks: s.layout.blocks })).toEqual([])
  })

  it('refuses a third image and a third QR block', () => {
    let s = fresh()
    for (let i = 0; i < 3; i++) s = designerReducer(s, { type: 'add', block: 'image' })
    for (let i = 0; i < 3; i++) s = designerReducer(s, { type: 'add', block: 'qr' })
    expect(count(s, 'image')).toBe(2)
    expect(count(s, 'qr')).toBe(2)
  })

  it('editing the url and the raster patches only that block', () => {
    let s = designerReducer(fresh(), { type: 'add', block: 'qr' })
    const id = s.editingId!
    s = designerReducer(s, { type: 'edit', id, patch: { url: 'https://instagram.com/x' } as never })
    expect(s.layout.blocks.find((b) => b.id === id)).toMatchObject({ type: 'qr', url: 'https://instagram.com/x' })
    s = designerReducer(s, { type: 'add', block: 'image' })
    const imgId = s.editingId!
    const image = { width: 8, height: 1, data: 'gA==' }
    s = designerReducer(s, { type: 'edit', id: imgId, patch: { image } as never })
    expect(s.layout.blocks.find((b) => b.id === imgId)).toMatchObject({ type: 'image', image })
  })

  it('a QR block can be deleted again and the cap frees up', () => {
    let s = designerReducer(designerReducer(fresh(), { type: 'add', block: 'qr' }), { type: 'add', block: 'qr' })
    s = designerReducer(s, { type: 'remove', id: s.editingId! })
    s = designerReducer(s, { type: 'add', block: 'qr' })
    expect(s.layout.blocks.filter((b) => b.type === 'qr')).toHaveLength(2)
  })

  it('the saved body carries the new blocks and no compat fields', () => {
    const s = designerReducer(fresh(), { type: 'add', block: 'qr' })
    const json = JSON.stringify(toBody(s))
    expect(json).toContain('"type":"qr"')
    for (const k of COMPAT_KEYS) expect(json).not.toContain(k)
  })
})
