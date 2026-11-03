import { describe, it, expect } from 'vitest'
import { parseListState, serializeListState } from '../../lib/router/useListState'
import {
  PRODUCTS_SCHEMA,
  activeFilterCount,
  clampPage,
  describeFilters,
  isPastLastPage,
  normalizeProductsList,
  stockLevel,
  stockText,
  toProductFilter,
  type ProductsListState,
} from './productsListState'

const CAT = '00000000-0000-4000-8f6b-0000000000a1'
const parse = (query: Record<string, string>): ProductsListState => parseListState(PRODUCTS_SCHEMA, query)
const norm = (query: Record<string, string>) => normalizeProductsList(parse(query))

describe('products list URL state', () => {
  it('reads every default from an empty query', () => {
    expect(norm({})).toEqual({ q: '', status: '', kategori: '', stok: '', urut: 'terbaru', hal: 1, per: 25, ubah: '', baru: false })
  })

  it('leaves defaults out of the URL and keeps the filters that are set', () => {
    const state = norm({ q: 'melati', status: 'aktif', kategori: CAT, stok: 'low', hal: '3', per: '50' })
    expect(serializeListState(PRODUCTS_SCHEMA, state)).toEqual({
      q: 'melati', status: 'aktif', kategori: CAT, stok: 'low', urut: undefined, hal: 3, per: 50, ubah: undefined, baru: undefined,
    })
  })

  it('falls back to the default for values a pasted URL should not be able to send', () => {
    const state = norm({ status: 'semua', stok: 'banyak', urut: 'harga', kategori: '../x', hal: '-4', per: '9999' })
    expect(state).toMatchObject({ status: '', stok: '', urut: 'terbaru', kategori: '', hal: 1, per: 25 })
    expect(norm({ hal: 'abc' }).hal).toBe(1)
    expect(norm({ hal: '2.7' }).hal).toBe(2)
  })
})

describe('toProductFilter', () => {
  it('sends nothing for the default state, so the request is the plain catalogue page', () => {
    expect(toProductFilter(norm({}))).toEqual({})
  })

  it('maps each filter to its server parameter and trims the search', () => {
    expect(toProductFilter(norm({ q: '  melati ', status: 'nonaktif', kategori: CAT, stok: 'out', urut: 'nama' }))).toEqual({
      q: 'melati', active: false, categoryId: CAT, stock: 'out', sort: 'nama',
    })
    expect(toProductFilter(norm({ status: 'aktif' })).active).toBe(true)
  })

  it('never sends an empty q', () => {
    expect(toProductFilter(norm({ q: '   ' }))).toEqual({})
  })
})

describe('filter summary and count', () => {
  it('counts only filters that differ from the default', () => {
    expect(activeFilterCount(norm({}))).toBe(0)
    expect(activeFilterCount(norm({ q: 'x', stok: 'low', hal: '4' }))).toBe(2)
    expect(activeFilterCount(norm({ urut: 'nama' }))).toBe(1)
  })

  it('describes the filters in plain words', () => {
    const state = norm({ q: 'melati', status: 'aktif', kategori: CAT, stok: 'out' })
    expect(describeFilters(state, (id) => (id === CAT ? 'Floral' : undefined))).toEqual([
      'Cari: melati', 'Status: Aktif', 'Kategori: Floral', 'Stok: Habis',
    ])
    expect(describeFilters(norm({}), () => undefined)).toEqual([])
  })
})

describe('paging', () => {
  it('clamps a page to the last one that can hold rows', () => {
    expect(clampPage(99, 60, 25)).toBe(3)
    expect(clampPage(2, 60, 25)).toBe(2)
    expect(clampPage(5, 0, 25)).toBe(1)
    expect(clampPage(0, 60, 25)).toBe(1)
  })

  it('treats an empty page after the first as past the end', () => {
    expect(isPastLastPage(3, 0)).toBe(true)
    expect(isPastLastPage(1, 0)).toBe(false)
    expect(isPastLastPage(3, 4)).toBe(false)
  })
})

describe('stock level (D-81: low is 1-2 units)', () => {
  it('names out, low and ok', () => {
    expect([0, -1, 1, 2, 3].map(stockLevel)).toEqual(['out', 'out', 'low', 'low', 'ok'])
    expect([0, 2, 12].map(stockText)).toEqual(['Habis', '2 (rendah)', '12'])
  })
})
