import { describe, expect, it } from 'vitest'
import { buildHash, normalizeHash, parseHash } from './hash'

describe('parseHash', () => {
  it('splits path segments and query', () => {
    expect(parseHash('#/laporan/refund?dari=2026-11-01&status=open')).toEqual({
      path: ['laporan', 'refund'],
      query: { dari: '2026-11-01', status: 'open' },
    })
  })

  it('treats an empty or root hash as the empty location', () => {
    expect(parseHash('')).toEqual({ path: [], query: {} })
    expect(parseHash('#')).toEqual({ path: [], query: {} })
    expect(parseHash('#/')).toEqual({ path: [], query: {} })
  })

  it('accepts the hash with or without "#" and a leading slash', () => {
    expect(parseHash('laporan').path).toEqual(['laporan'])
    expect(parseHash('/laporan/').path).toEqual(['laporan'])
    expect(parseHash('#laporan').path).toEqual(['laporan'])
  })

  it('decodes percent escapes and plus signs in the query', () => {
    expect(parseHash('#/produk?q=lilin%20wangi&kategori=a+b')).toEqual({
      path: ['produk'],
      query: { q: 'lilin wangi', kategori: 'a b' },
    })
  })

  it('keeps a malformed escape as typed instead of throwing', () => {
    expect(parseHash('#/produk?q=%E0%A4%A').query.q).toBe('%E0%A4%A')
    expect(parseHash('#/%zz').path).toEqual(['%zz'])
  })

  it('keeps a valueless key as an empty string and the last duplicate', () => {
    expect(parseHash('#/x?baru&a=1&a=2').query).toEqual({ baru: '', a: '2' })
  })

  it('ignores a __proto__ key', () => {
    const { query } = parseHash('#/x?__proto__=evil&a=1')
    expect(Object.keys(query)).toEqual(['a'])
    expect(({} as Record<string, unknown>).evil).toBeUndefined()
  })
})

describe('buildHash', () => {
  it('writes the canonical form', () => {
    expect(buildHash(['laporan', 'refund'], { dari: '2026-11-01', status: 'open' })).toBe(
      '#/laporan/refund?dari=2026-11-01&status=open',
    )
    expect(buildHash([])).toBe('#/')
  })

  it('leaves out undefined, null and empty values but keeps 0 and false', () => {
    expect(buildHash(['produk'], { q: '', hal: undefined, status: null, per: 0, aktif: false })).toBe(
      '#/produk?per=0&aktif=false',
    )
  })

  it('encodes what needs it', () => {
    expect(buildHash(['produk'], { q: 'a&b=c d' })).toBe('#/produk?q=a%26b%3Dc%20d')
    expect(buildHash(['a/b'])).toBe('#/a%2Fb')
  })

  it('round-trips through parseHash', () => {
    const loc = { path: ['inventori', 'stok', 'lokasi', 'outlet', 'id with space'], query: { q: 'a&b', hal: '2' } }
    expect(parseHash(buildHash(loc.path, loc.query))).toEqual(loc)
  })
})

describe('normalizeHash', () => {
  it('gives every spelling of the same place one form', () => {
    const forms = ['#/laporan?x=1', '/laporan?x=1', 'laporan?x=1', '#laporan/?x=1']
    expect(new Set(forms.map(normalizeHash)).size).toBe(1)
    expect(normalizeHash('')).toBe('#/')
  })
})
