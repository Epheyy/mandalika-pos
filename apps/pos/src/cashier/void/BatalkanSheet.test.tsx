import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { BatalkanSheet } from './BatalkanSheet'
import { batalkanInput, initialBatalkan, setStockChoice } from './batalkanState'

type Order = components['schemas']['Order']
type VoidPreview = components['schemas']['VoidPreview']

const order = { id: 'o1', orderNumber: 'BSD-00398', status: 'completed', total: 350000, items: [] } as unknown as Order

const line = (key: string, countedAfter: boolean, name = 'Rehearsal Alpha') =>
  ({ key, productId: `p-${key}`, productName: name, variantSize: '50 ml', quantity: 1, countedAfter, ...(countedAfter ? { stockCountName: 'Opname 3 Nov' } : {}) })
const preview = (lines: ReturnType<typeof line>[], over: Partial<VoidPreview> = {}): VoidPreview =>
  ({ eligible: true, afterClose: false, amountsLocked: false, windowDays: 7, lines, ...over }) as VoidPreview

const html = (p: VoidPreview | null, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(BatalkanSheet, { order, preview: p, onConfirm: vi.fn(), onClose: vi.fn(), ...extra })).replace(/\s+/g, ' ')

describe('BatalkanSheet', () => {
  it('sheet requires a reason', () => {
    const s = initialBatalkan(null)
    expect(batalkanInput(s, null)).toBeNull()
    // The confirm bar is disabled until a reason is picked.
    expect(html(null)).toMatch(/<button type="button" disabled=""[^>]*>Batalkan &amp; perbaiki<\/button>/)
    // "Lainnya" needs a note of at least 10 characters.
    expect(batalkanInput({ ...s, reason: 'lainnya', note: 'pendek' }, null)).toBeNull()
    expect(batalkanInput({ ...s, reason: 'lainnya', note: 'salah input harga' }, null)).toMatchObject({ reason: 'lainnya' })
    expect(batalkanInput({ ...s, reason: 'salah_barang' }, null)).toMatchObject({ reason: 'salah_barang', note: '' })
  })

  it('sheet defaults to Batalkan & perbaiki', () => {
    expect(initialBatalkan(null).choice).toBe('perbaiki')
    const out = html(null)
    expect(out).toContain('Batalkan transaksi #BSD-00398')
    expect(out).toMatch(/aria-pressed="true"[^>]*><span[^>]*>Batalkan &amp; perbaiki/)
    expect(out).toContain('Batalkan saja')
    expect(batalkanInput({ ...initialBatalkan(null), reason: 'salah_promo', choice: 'saja' }, null)?.choice).toBe('saja')
  })

  it('sheet shows counted lines with kembalikan stok selected and returns stockChoices with skip_counted for sudah dikoreksi', () => {
    const p = preview([line('k1', true), line('k2', false, 'Tas Kanvas')])
    const out = html(p)
    expect(out).toContain('Stock opname setelah transaksi ini sudah menghitung barang berikut.')
    expect(out).toMatch(/aria-pressed="true"[^>]*>(<[^>]*>)*kembalikan stok/)
    expect(out).toContain('sudah dikoreksi oleh stock opname')
    // Only the counted line is listed.
    expect(out).not.toContain('Tas Kanvas')
    const s = setStockChoice({ ...initialBatalkan(p), reason: 'salah_barang' }, 'k1', 'skip_counted')
    expect(batalkanInput(s, p)?.stockChoices).toEqual({ k1: 'skip_counted' })
  })

  it('sheet returns a restock choice for every counted line left at the default', () => {
    const p = preview([line('k1', true), line('k2', true, 'Oud'), line('k3', false, 'Tas')])
    const s = { ...initialBatalkan(p), reason: 'transaksi_tes' as const }
    expect(batalkanInput(s, p)?.stockChoices).toEqual({ k1: 'restock', k2: 'restock' })
  })

  it('offline sheet shows no opname section', () => {
    const out = html(null)
    expect(out).not.toContain('Stock opname')
    expect(out).not.toContain('kembalikan stok')
    expect(batalkanInput({ ...initialBatalkan(null), reason: 'salah_barang' }, null)?.stockChoices).toEqual({})
  })

  it('shows the refusal and never confirms when the preview says not eligible; waits while the preview loads', () => {
    const p = preview([], { eligible: false, refusal: 'Transaksi ini sudah dibatalkan.' })
    expect(html(p)).toContain('Transaksi ini sudah dibatalkan.')
    expect(batalkanInput({ ...initialBatalkan(p), reason: 'salah_barang' }, p)).toBeNull()
    expect(html(null, { previewLoading: true })).toContain('Memeriksa stock opname')
  })
})
