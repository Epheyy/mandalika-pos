import { describe, expect, it, vi } from 'vitest'
import type { ListOrdersResult, Order } from '@mandalika/api'
import { exportCutoffLabel, orderExportPager } from './ordersExportPaging'

const order = (n: number) => ({ id: `id-${n}` }) as Order

/** A fake keyset server over `total` rows; cursor = index of the next row. */
function keysetApi(total: number) {
  const calls: Record<string, unknown>[] = []
  const listOrders = vi.fn(async (params: Record<string, unknown> = {}): Promise<ListOrdersResult> => {
    calls.push(params)
    const limit = Number(params.limit)
    const start = params.cursor ? Number(String(params.cursor).slice(1)) : 0
    const data = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => order(total - (start + i)))
    const next = data.length === limit ? `c${start + limit}` : undefined
    return { data, meta: { total, page: 1, limit }, ...(next ? { nextCursor: next } : {}) }
  })
  return { listOrders, calls }
}

describe('orders export paging', () => {
  it('Orders export pages by cursor and keeps server order', async () => {
    const api = keysetApi(2500)
    const rows = await orderExportPager(api, { dateFrom: '2026-10-01' })
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => `id-${2500 - i}`))
    expect(api.calls).toHaveLength(3)
    expect(api.calls.every((c) => c.paging === 'keyset' && c.limit === 1000 && c.dateFrom === '2026-10-01')).toBe(true)
    expect('cursor' in api.calls[0]).toBe(false) // the first request must not send "undefined"
    expect(api.calls[1].cursor).toBe('c1000')
    expect(api.calls[2].cursor).toBe('c2000')
  })

  it('falls back to offset paging against a backend that ignores paging=keyset', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => order(450 - i))
    const listOrders = vi.fn(async (p: Record<string, unknown> = {}): Promise<ListOrdersResult> => {
      const limit = p.paging ? 50 : Number(p.limit) // an old backend clamps limit>200 to 50
      const page = p.paging ? 1 : Number(p.page)
      return { data: rows.slice((page - 1) * limit, page * limit), meta: { total: 450, page, limit } }
    })
    const got = await orderExportPager({ listOrders }, {})
    expect(got).toEqual(rows)
  })

  it('labels the cut-off', () => {
    expect(exportCutoffLabel(new Date(2026, 10, 10, 14, 52))).toMatch(/^Data s\.d\. 10 Nov 14\.52$|^Data s\.d\. 10 Nov 14:52$/)
  })
})
