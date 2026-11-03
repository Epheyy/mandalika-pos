import { describe, expect, it } from 'vitest'
import { activeTab, segmentAfter, slugForTab, tabForSegment } from './tabs'

const tabs = [
  { key: 'orders', slug: 'transaksi' },
  { key: 'codeReport', slug: 'kode-diskon' },
  { key: 'refund', slug: 'refund' },
] as const

describe('tabForSegment', () => {
  it('finds a tab by its slug', () => {
    expect(tabForSegment(tabs, 'kode-diskon')).toBe('codeReport')
  })
  it('knows nothing of a missing or unknown segment', () => {
    expect(tabForSegment(tabs, undefined)).toBeUndefined()
    expect(tabForSegment(tabs, 'codeReport')).toBeUndefined() // the key is not the slug
    expect(tabForSegment(tabs, 'bahan')).toBeUndefined()
  })
})

describe('activeTab', () => {
  it('is the tab the path names', () => {
    expect(activeTab(tabs, 'refund')).toBe('refund')
  })
  it('is the first tab for a bare path or an unknown segment', () => {
    expect(activeTab(tabs, undefined)).toBe('orders')
    expect(activeTab(tabs, 'bahan')).toBe('orders')
  })
  it('falls back to the first tab that is available, so a gated tab re-resolves once it appears', () => {
    const before = [{ key: 'stok', slug: 'stok' }, { key: 'opname', slug: 'opname' }] as const
    const after = [{ key: 'stok', slug: 'stok' }, { key: 'bahan', slug: 'bahan' }, { key: 'opname', slug: 'opname' }] as const
    expect(activeTab(before, 'bahan')).toBe('stok')
    expect(activeTab(after, 'bahan')).toBe('bahan')
  })
  it('is undefined when no tab is available', () => {
    expect(activeTab([], 'refund')).toBeUndefined()
  })
})

describe('slugForTab', () => {
  it('maps a key back to its slug', () => {
    expect(slugForTab(tabs, 'codeReport')).toBe('kode-diskon')
    expect(slugForTab(tabs, 'oversell' as never)).toBeUndefined()
  })
})

describe('segmentAfter', () => {
  it('reads the segment under a base, optionally further down', () => {
    expect(segmentAfter(['inventori', 'stok', 'kartu-stok'], ['inventori', 'stok'])).toBe('kartu-stok')
    expect(segmentAfter(['inventori', 'transfer', 'abc', 'ubah'], ['inventori', 'transfer'], 1)).toBe('ubah')
  })
  it('is undefined at the base itself and outside it', () => {
    expect(segmentAfter(['inventori', 'stok'], ['inventori', 'stok'])).toBeUndefined()
    expect(segmentAfter(['inventori', 'transfer', 'x'], ['inventori', 'stok'])).toBeUndefined()
    expect(segmentAfter(['laporan'], ['inventori', 'stok'])).toBeUndefined()
  })
})
