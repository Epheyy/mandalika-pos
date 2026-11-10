import { describe, expect, it, vi } from 'vitest'
import { fetchAllByCursor, fetchAllPages, KEYSET_PAGE_SIZE, type CursorListResult, type ListResult, type Order, type Product } from '@mandalika/api'
import { buildTrend, cashierPerformance, completedIn, computeKpis, lowStock, paymentBreakdown, periodInterval, productRanking } from './dashboard/metrics'

function pages<T>(rows: T[]) {
  return vi.fn(async (page: number, limit: number): Promise<ListResult<T>> => ({
    data: rows.slice((page - 1) * limit, page * limit), meta: { total: rows.length, page, limit },
  }))
}

describe('complete pagination', () => {
  it.each([0, 1, 50, 51, 200, 201, 401, 1000])('retrieves %i in exact server order with bounded calls', async total => {
    const rows = Array.from({ length: total }, (_, i) => ({ id: `id-${total - i}` }))
    const fetch = pages(rows)
    expect(await fetchAllPages(fetch)).toEqual(rows)
    expect(fetch.mock.calls).toEqual(Array.from({ length: Math.max(1, Math.ceil(total / 200)) }, (_, i) => [i + 1, 200]))
  })
  it('rejects a later failure instead of returning the successful prefix', async () => {
    const fetch = pages(Array.from({ length: 401 }, (_, i) => ({ id: `${i}` })))
    fetch.mockImplementationOnce(async (page, limit) => ({ data: Array.from({ length: 200 }, (_, i) => ({ id: `${i}` })), meta: { total: 401, page, limit } }))
      .mockRejectedValueOnce(new Error('page 2 unavailable'))
    await expect(fetchAllPages(fetch)).rejects.toThrow('page 2 unavailable')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each(['empty', 'short', 'duplicate', 'changed-total', 'changed-limit', 'wrong-page'])('rejects %s on page 2', async kind => {
    const rows = Array.from({ length: 401 }, (_, i) => ({ id: `${i}` }))
    const fetch = vi.fn(async (page: number, limit: number) => {
      const r = await pages(rows)(page, limit)
      if (page === 2) {
        if (kind === 'empty') r.data = []
        if (kind === 'short') r.data.pop()
        if (kind === 'duplicate') r.data[0] = rows[0]
        if (kind === 'changed-total') r.meta!.total++
        if (kind === 'changed-limit') r.meta!.limit = 50
        if (kind === 'wrong-page') r.meta!.page = 1
      }
      return r
    })
    await expect(fetchAllPages(fetch)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each([undefined, {}, { total: -1, page: 1, limit: 200 }, { total: 1.5, page: 1, limit: 200 }, { total: '1', page: 1, limit: 200 }, { total: 0, page: 1, limit: 50 }, { total: Number.MAX_SAFE_INTEGER, page: 1, limit: 200 }])('rejects malformed or excessive metadata %j', async meta => {
    const fetch = vi.fn(async () => ({ data: [], meta }) as unknown as ListResult<{ id: string }>)
    await expect(fetchAllPages(fetch)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([{ data: [{ id: '' }] }, { data: [{ id: 'x' }, { id: 'x' }] }, { data: [null] }])('rejects missing/duplicate row identity', async ({ data }) => {
    await expect(fetchAllPages(pages(data as { id: string }[]))).rejects.toThrow()
  })
})

/** A keyset server over `rows`: cursor = index of the next row; every page reports page 1. */
function cursorPages<T>(rows: T[]) {
  return vi.fn(async (cursor: string | undefined, limit: number): Promise<CursorListResult<T>> => {
    const start = cursor ? Number(cursor.slice(1)) : 0
    const data = rows.slice(start, start + limit)
    return { data, meta: { total: rows.length, page: 1, limit }, ...(data.length === limit ? { nextCursor: `c${start + limit}` } : {}) }
  })
}
const noFallback = async (): Promise<{ id: string }[]> => { throw new Error('fallback must not run') }

describe('complete keyset pagination', () => {
  it.each([0, 1, 999, 1000, 1001, 101018])('retrieves %i rows with ceil(total/1000) calls', async total => {
    const rows = Array.from({ length: total }, (_, i) => ({ id: `id-${total - i}` }))
    const fetch = cursorPages(rows)
    expect(await fetchAllByCursor(fetch, noFallback)).toEqual(rows)
    expect(fetch).toHaveBeenCalledTimes(Math.max(1, Math.ceil(total / 1000)))
    expect(fetch.mock.calls[0]).toEqual([undefined, KEYSET_PAGE_SIZE])
  })
  it('stops at total without an extra request', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `${i}` }))
    const fetch = cursorPages(rows) // the last full page still carries a nextCursor
    await fetchAllByCursor(fetch, noFallback)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each(['empty', 'short', 'duplicate', 'changed-total', 'bad-limit', 'missing-cursor-before-complete', 'blank-id'])('fetchAllByCursor rejects %s on page 2', async kind => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `${i}` }))
    const base = cursorPages(rows)
    const fetch = vi.fn(async (cursor: string | undefined, limit: number) => {
      const r = await base(cursor, limit)
      if (cursor) {
        if (kind === 'empty') r.data = []
        if (kind === 'short') r.data.pop()
        if (kind === 'duplicate') r.data[0] = rows[0]
        if (kind === 'changed-total') r.meta!.total++
        if (kind === 'bad-limit') r.meta!.limit = 200
        if (kind === 'missing-cursor-before-complete') delete r.nextCursor
        if (kind === 'blank-id') r.data[0] = { id: ' ' }
      }
      return r
    })
    await expect(fetchAllByCursor(fetch, noFallback)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('rejects a later failure instead of returning the successful prefix', async () => {
    const base = cursorPages(Array.from({ length: 2500 }, (_, i) => ({ id: `${i}` })))
    const fetch = vi.fn(async (c: string | undefined, l: number) => { if (c) throw new Error('page 2 unavailable'); return base(c, l) })
    await expect(fetchAllByCursor(fetch, noFallback)).rejects.toThrow('page 2 unavailable')
  })
  it('rejects a repeated cursor instead of looping', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ id: `${i}` }))
    const fetch = vi.fn(async (_c: string | undefined, limit: number) => ({ data: rows.slice(0, limit).map((r, i) => ({ id: `${r.id}-${fetch.mock.calls.length}-${i}` })), meta: { total: 3000, page: 1, limit }, nextCursor: 'same' }))
    await expect(fetchAllByCursor(fetch, noFallback)).rejects.toThrow()
  })
  it('falls back to offset paging when the backend ignores paging=keyset', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `${i}` }))
    const old = vi.fn(async (_c: string | undefined, _l: number) => ({ data: rows.slice(0, 50), meta: { total: 450, page: 1, limit: 50 } }))
    const fallback = vi.fn(async () => fetchAllPages(pages(rows)))
    expect(await fetchAllByCursor(old, fallback)).toEqual(rows)
    expect(old).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, {}, { total: -1, page: 1, limit: 1000 }, { total: 1.5, page: 1, limit: 1000 }, { total: 0, page: 2, limit: 1000 }])('rejects malformed page-1 metadata %j', async meta => {
    const fetch = vi.fn(async () => ({ data: [], meta }) as unknown as CursorListResult<{ id: string }>)
    await expect(fetchAllByCursor(fetch, noFallback)).rejects.toThrow()
  })
})

describe('unchanged dashboard calculations consume the complete list', () => {
  const now = new Date('2026-09-21T12:00:00')
  it.each([51, 201, 1000])('%i orders feed every metric', async total => {
    const ledger = Array.from({ length: total }, (_, i) => ({ id: `${i}`, status: 'completed', total: 1000, customerId: `c-${i}`, cashierId: 'c', cashierName: 'Cashier', paymentMethod: i % 2 ? 'qris' : 'cash', createdAt: '2026-09-21T10:00:00', items: [{ productId: 'p', productName: 'P', variantSize: 'M', quantity: 2 }] })) as Order[]
    const orders = completedIn(await fetchAllPages(pages(ledger)), periodInterval('today', now))
    expect(computeKpis(orders)).toEqual({ revenue: total * 1000, orders: total, itemsSold: total * 2, customers: total })
    expect(buildTrend(orders, 'today', now).reduce((s, p) => s + p.revenue, 0)).toBe(total * 1000)
    expect(paymentBreakdown(orders).reduce((s, p) => s + p.amount, 0)).toBe(total * 1000)
    expect(cashierPerformance(orders)[0].revenue).toBe(total * 1000)
    expect(productRanking(orders)[0].qty).toBe(total * 2)
  })
  it('includes low stock on the final product page', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ id: `${i}`, name: `P${i}`, variants: [{ size: 'M', stock: i === 200 ? 0 : 100 }] })) as Product[]
    expect(lowStock(await fetchAllPages(pages(rows)))).toEqual([{ name: 'P200 M', stock: 0 }])
  })
  it('preserves fixed period boundaries and completed-only filtering', () => {
    const rows = [{ id:'current', status:'completed', createdAt:'2026-09-21T10:00:00' }, { id:'past', status:'completed', createdAt:'2026-09-14T10:00:00' }, { id:'refund', status:'refunded', createdAt:'2026-09-21T10:00:00' }] as Order[]
    expect(completedIn(rows, periodInterval('7d', now)).map(o => o.id)).toEqual(['current'])
    expect(completedIn(rows, periodInterval('30d', now)).map(o => o.id)).toEqual(['current', 'past'])
  })
})
