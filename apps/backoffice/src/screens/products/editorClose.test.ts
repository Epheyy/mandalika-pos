import { describe, expect, it } from 'vitest'
import { openedFromList } from './editorClose'

describe('openedFromList', () => {
  const now = ['produk', 'daftar']
  it('is true when the entry before is the same list without an overlay', () => {
    expect(openedFromList('#/produk/daftar?q=a&hal=2', now)).toBe(true)
    expect(openedFromList('#/produk/daftar', now)).toBe(true)
  })
  it('is false for no previous entry, another path, or an overlay', () => {
    expect(openedFromList(undefined, now)).toBe(false)
    expect(openedFromList('#/promosi', now)).toBe(false)
    expect(openedFromList('#/produk/daftar?ubah=abc', now)).toBe(false)
    expect(openedFromList('#/produk/daftar?baru=1', now)).toBe(false)
  })
})
