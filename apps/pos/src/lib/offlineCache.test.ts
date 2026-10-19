import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORDER_HISTORY_CACHE_MAX, cacheRead, cacheWrite, sweepOrderHistoryCache } from './offlineCache'

// A41/A30: the history cache must never hold a typed search (phone or name) in a key or a row, and must
// stay bounded. The boot sweep removes what older builds wrote.

const P = 'mandalika.cache.'
let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

const seed = (...keys: string[]) => keys.forEach((k) => store.set(P + k, '{"orders":[{"customerName":"Budi"}],"total":1}'))
const left = () => [...store.keys()].map((k) => (k.startsWith(P) ? k.slice(P.length) : k)).sort()

describe('sweepOrderHistoryCache', () => {
  it('removes every business-day key that carries a search term, including terms with a colon', () => {
    seed('orders:bd:2026-10-19:2026-10-19:1:', 'orders:bd:2026-10-19:2026-10-19:1:0812345', 'orders:bd:2026-10-19:2026-10-19:2:budi', 'orders:bd:2026-10-19:2026-10-19:1:a:b')
    expect(sweepOrderHistoryCache()).toBe(3)
    expect(left()).toEqual(['orders:bd:2026-10-19:2026-10-19:1:'])
  })

  it('removes the legacy UTC-day keys (never read by this build), with or without a term', () => {
    seed('orders:2026-10-19:2026-10-19:1:', 'orders:2026-10-19:2026-10-19:1:0812345')
    expect(sweepOrderHistoryCache()).toBe(2)
    expect(left()).toEqual([])
  })

  it('leaves the last-result alias and unrelated cache keys alone', () => {
    seed('orders:last', 'rekap:orders:shift-1', 'recap:x', 'orders:bd:2026-10-19:2026-10-19:1:')
    store.set('other.key', 'x')
    expect(sweepOrderHistoryCache()).toBe(0)
    expect(left()).toEqual(['orders:bd:2026-10-19:2026-10-19:1:', 'orders:last', 'other.key', 'recap:x', 'rekap:orders:shift-1'])
  })

  it('bounds the term-less keys to the newest ones by date', () => {
    const days = Array.from({ length: ORDER_HISTORY_CACHE_MAX + 5 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, '0')}`)
    const keys = days.map((d, i) => `orders:bd:${d}:${d}:${i + 1}:`)
    seed(...keys)
    expect(sweepOrderHistoryCache()).toBe(5)
    expect(left()).toHaveLength(ORDER_HISTORY_CACHE_MAX)
  })

  it('keeps the newest days when it trims', () => {
    seed('orders:bd:2026-01-01:2026-01-01:1:', 'orders:bd:2026-10-19:2026-10-19:1:', 'orders:bd:2026-10-18:2026-10-18:1:')
    expect(sweepOrderHistoryCache(2)).toBe(1)
    expect(left()).toEqual(['orders:bd:2026-10-18:2026-10-18:1:', 'orders:bd:2026-10-19:2026-10-19:1:'])
  })

  it('is safe when storage throws', () => {
    vi.stubGlobal('localStorage', { get length(): number { throw new Error('denied') }, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} })
    expect(sweepOrderHistoryCache()).toBe(0)
  })
})

describe('cacheWrite / cacheRead are unchanged', () => {
  it('round-trips and falls back to the alias', () => {
    cacheWrite('k', { a: 1 }, 'alias')
    expect(cacheRead('k')).toEqual({ a: 1 })
    expect(cacheRead('missing', 'alias')).toEqual({ a: 1 })
  })
})
