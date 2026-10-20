import { describe, expect, it, vi } from 'vitest'
import type { Ingredient, ListResult, Product } from '@mandalika/api'
import { loadAllIngredients, loadAllProducts } from './loadAll'

function fake<T>(rows: T[]) {
  return vi.fn(async (page: number, limit: number): Promise<ListResult<T>> => ({
    data: rows.slice((page - 1) * limit, page * limit), meta: { total: rows.length, page, limit },
  }))
}

describe('loadAll', () => {
  it('returns all 450 products across 200-row pages', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `p${i}` }) as Product)
    const list = fake(rows)
    expect(await loadAllProducts(list)).toHaveLength(450)
    expect(list.mock.calls).toEqual([[1, 200], [2, 200], [3, 200]])
  })
  it('returns all 450 ingredients', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `i${i}` }) as Ingredient)
    expect(await loadAllIngredients(fake(rows))).toHaveLength(450)
  })
})
