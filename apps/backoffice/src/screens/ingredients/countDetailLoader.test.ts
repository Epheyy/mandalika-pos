import { describe, expect, it, vi } from 'vitest'
import type { IngredientStockCountItem } from '@mandalika/api'
import { createCountDetailLoader, idsToLoad, type DetailMap } from './countDetailLoader'

const line = (counted: number) => ({ id: 'l1', counted }) as unknown as IngredientStockCountItem
const harness = (fetchCount: Parameters<typeof createCountDetailLoader>[0]) => {
  let state: DetailMap = {}
  const load = createCountDetailLoader(fetchCount, (u) => {
    state = u(state)
  })
  return { load, get: () => state }
}

describe('idsToLoad', () => {
  it('reloads an in-progress count that is already loaded when it is expanded again', () => {
    expect(idsToLoad('c1:in_progress', 'c1:in_progress', null, 'c1')).toEqual(['c1'])
  })
  it('does not reload on collapse or unrelated re-renders', () => {
    expect(idsToLoad('c1:in_progress', 'c1:in_progress', 'c1', null)).toEqual([])
    expect(idsToLoad('c1:in_progress', 'c1:in_progress', 'c1', 'c1')).toEqual([])
  })
  it('loads newly wanted counts and status changes once (no double load on expand)', () => {
    expect(idsToLoad('', 'c2:completed', null, 'c2')).toEqual(['c2'])
    expect(idsToLoad('c1:draft', 'c1:in_progress', null, null)).toEqual(['c1'])
  })
})

describe('createCountDetailLoader', () => {
  it('refetches and shows the new value, keeping old lines while loading', async () => {
    const fetchCount = vi
      .fn()
      .mockResolvedValueOnce({ items: [line(2.5)] })
      .mockResolvedValueOnce({ items: [line(3.5)] })
    const { load, get } = harness(fetchCount)
    await load('c1')
    expect(get().c1.items?.[0].counted).toBe(2.5)
    const second = load('c1')
    expect(get().c1.items?.[0].counted).toBe(2.5)
    expect(get().c1.loading).toBe(true)
    await second
    expect(fetchCount).toHaveBeenCalledTimes(2)
    expect(get().c1.items?.[0].counted).toBe(3.5)
  })

  it('ignores a slow older response that arrives after a newer one', async () => {
    let resolveOld!: (v: { items: IngredientStockCountItem[] }) => void
    const fetchCount = vi
      .fn()
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r }))
      .mockResolvedValueOnce({ items: [line(3.5)] })
    const { load, get } = harness(fetchCount)
    const old = load('c1')
    await load('c1')
    resolveOld({ items: [line(2.5)] })
    await old
    expect(get().c1.items?.[0].counted).toBe(3.5)
  })

  it('keeps old lines and records the error when a refresh fails', async () => {
    const fetchCount = vi
      .fn()
      .mockResolvedValueOnce({ items: [line(2.5)] })
      .mockRejectedValueOnce(new Error('boom'))
    const { load, get } = harness(fetchCount)
    await load('c1')
    await load('c1')
    expect(get().c1.items?.[0].counted).toBe(2.5)
    expect(get().c1.error).toBe('boom')
  })
})
