import { describe, expect, it } from 'vitest'
import { completeIngredientCountConfirm, summarizeIngredientCount } from './opnameConfirm'

describe('summarizeIngredientCount', () => {
  it('counts the lines with a saved quantity (zero is a count)', () => {
    expect(summarizeIngredientCount([{ counted: 0 }, { counted: 5 }, { counted: null }, {}])).toEqual({ total: 4, counted: 2, uncounted: 2 })
  })
})

describe('completeIngredientCountConfirm', () => {
  it('names the location, how many ingredients are replaced and how many are left alone', () => {
    const c = completeIngredientCountConfirm('Opname Mei', 'Gudang Pusat', { total: 5, counted: 3, uncounted: 2 })
    expect(c.title).toBe('Selesaikan opname Opname Mei?')
    expect(c.consequence).toContain('Stok 3 bahan di Gudang Pusat diganti')
    expect(c.consequence).toContain('2 bahan yang belum dihitung tidak diubah')
  })
  it('says nothing changes when nothing is counted', () => {
    expect(completeIngredientCountConfirm('X', 'Gudang', { total: 2, counted: 0, uncounted: 2 }).consequence).toContain('tidak berubah')
  })
})
