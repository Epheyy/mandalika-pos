import { describe, expect, it } from 'vitest'
import type { RouteMove } from './navigate'
import { canReach, MAX_REMEMBERED, remember, scrollPlan } from './scroll'

const move = (kind: RouteMove['kind'], from: string[], to: string[], toIdx = 1): RouteMove => ({
  kind,
  from: { idx: 2, path: from },
  to: { idx: toIdx, path: to },
})

describe('scrollPlan', () => {
  const saved = new Map([[1, 480]])
  it('keeps the scroll when only the query changed', () => {
    expect(scrollPlan(move('push', ['pelanggan', 'daftar'], ['pelanggan', 'daftar']), saved)).toEqual({ kind: 'keep' })
    expect(scrollPlan(move('pop', ['laporan'], ['laporan']), saved)).toEqual({ kind: 'keep' })
    expect(scrollPlan(move('replace', ['produk'], ['produk']), saved)).toEqual({ kind: 'keep' })
  })
  it('starts at the top on a push or replace to another path', () => {
    expect(scrollPlan(move('push', ['pelanggan', 'daftar'], ['pelanggan', 'daftar', 'abc']), saved)).toEqual({ kind: 'top' })
    expect(scrollPlan(move('replace', ['a'], ['b']), saved)).toEqual({ kind: 'top' })
  })
  it('restores the remembered scroll on Back/Forward to another path', () => {
    expect(scrollPlan(move('pop', ['pelanggan', 'daftar', 'abc'], ['pelanggan', 'daftar']), saved)).toEqual({ kind: 'restore', top: 480 })
  })
  it('starts at the top when the entry was never remembered or sat at 0', () => {
    expect(scrollPlan(move('pop', ['a'], ['b'], 7), saved)).toEqual({ kind: 'top' })
    expect(scrollPlan(move('pop', ['a'], ['b'], 3), new Map([[3, 0]]))).toEqual({ kind: 'top' })
  })
})

describe('remember', () => {
  it('overwrites an idx and drops the oldest past the cap', () => {
    const m = new Map<number, number>()
    for (let i = 0; i < MAX_REMEMBERED + 5; i += 1) remember(m, i, i + 1)
    expect(m.size).toBe(MAX_REMEMBERED)
    expect(m.has(0)).toBe(false)
    remember(m, 10, 99)
    expect(m.get(10)).toBe(99)
  })
})

describe('canReach', () => {
  it('is true once the content is tall enough', () => {
    expect(canReach(500, 1400, 800)).toBe(true)
    expect(canReach(700, 1400, 800)).toBe(false)
  })
})
