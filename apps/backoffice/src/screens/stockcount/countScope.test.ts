import { describe, expect, it } from 'vitest'
import { countErrorMessage, freezeSummary, newestFirst, withCountScope } from './countScope'

describe('withCountScope', () => {
  it('runs an outlet count under its own outlet and restores the previous scope', async () => {
    const store = { outletId: null as string | null }
    let seen: string | null = 'unset'
    await withCountScope(store, { outletId: 'o1', warehouseId: null }, async () => { seen = store.outletId })
    expect(seen).toBe('o1')
    expect(store.outletId).toBeNull()
  })
  it('restores the previous scope when the call throws', async () => {
    const store = { outletId: 'home' as string | null }
    await expect(withCountScope(store, { outletId: 'o1', warehouseId: null }, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(store.outletId).toBe('home')
  })
  it('leaves the scope alone for a warehouse count', async () => {
    const store = { outletId: null as string | null }
    let seen: string | null = 'unset'
    await withCountScope(store, { outletId: null, warehouseId: 'w1' }, async () => { seen = store.outletId })
    expect(seen).toBeNull()
  })
  it('leaves the scope alone when the count carries no outlet', async () => {
    const store = { outletId: 'home' as string | null }
    let seen: string | null = 'unset'
    await withCountScope(store, { outletId: null, warehouseId: null }, async () => { seen = store.outletId })
    expect(seen).toBe('home')
  })
  it('returns the call result', async () => {
    const store = { outletId: null as string | null }
    expect(await withCountScope(store, { outletId: 'o1', warehouseId: null }, async () => 42)).toBe(42)
  })
})

describe('countErrorMessage', () => {
  it('rewrites a bare not found', () => {
    expect(countErrorMessage(new Error('not found'), 'x')).toMatch(/^Opname tidak ditemukan/)
  })
  it('keeps other server messages and falls back for non-errors', () => {
    expect(countErrorMessage(new Error('stock count lain di lokasi ini masih berjalan'), 'x')).toBe('stock count lain di lokasi ini masih berjalan')
    expect(countErrorMessage('oops', 'fallback')).toBe('fallback')
  })
})

describe('newestFirst', () => {
  it('orders by createdAt descending without mutating the input', () => {
    const input = [{ createdAt: '2026-11-01T00:00:00Z' }, { createdAt: '2026-11-03T00:00:00Z' }, { createdAt: '2026-11-02T00:00:00Z' }]
    expect(newestFirst(input).map((c) => c.createdAt.slice(8, 10))).toEqual(['03', '02', '01'])
    expect(input[0].createdAt.slice(8, 10)).toBe('01')
  })
})

describe('freezeSummary', () => {
  it('counts products and their variants', () => {
    expect(freezeSummary([{ variants: [{}, {}] }, { variants: [{}] }] as never)).toBe('2 produk · 3 varian aktif')
  })
})
