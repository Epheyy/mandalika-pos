import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type DashboardAggregate, type Order } from '@mandalika/api'
import { AGGREGATE_REPROBE_MS, DASHBOARD_POLL_MS, aggregateRefreshMs, fetchDashboard, resetAggregateProbe } from './fetchDashboard'

const NOW = Date.parse('2026-11-04T07:00:00Z')
const agg = {
  current: {}, trend: [], topProducts: [], bottomProducts: [], cashiers: [], promoTally: [],
  grossByPaymentMethod: {}, refundsByPaymentMethod: {}, distinctProducts: 0,
} as unknown as DashboardAggregate

function fakeApi(opts: { dashboard?: () => Promise<DashboardAggregate>; refundRows?: Order[] }) {
  const reportDashboard = vi.fn((_params: unknown) => (opts.dashboard ? opts.dashboard() : Promise.resolve(agg)))
  const listOrders = vi.fn((p: { dateBasis?: string }) => {
    const data = p.dateBasis === 'refund' ? (opts.refundRows ?? []) : []
    return Promise.resolve({ data, meta: { total: data.length, page: 1, limit: 200 } })
  })
  return { api: { reportDashboard, listOrders } as unknown as Parameters<typeof fetchDashboard>[0], reportDashboard, listOrders }
}

describe('fetchDashboard', () => {
  beforeEach(() => resetAggregateProbe())

  it('reads the server aggregate with one request and never lists orders', async () => {
    const { api, reportDashboard, listOrders } = fakeApi({})
    const r = await fetchDashboard(api, '7d', NOW)
    expect(r.kind).toBe('aggregate')
    expect(reportDashboard).toHaveBeenCalledTimes(1)
    expect(reportDashboard.mock.calls[0][0]).toMatchObject({ dateFrom: '2026-10-29', dateTo: '2026-11-04', trend: 'day' })
    expect(listOrders).not.toHaveBeenCalled()
  })

  it.each([404, 405])('falls back to the order lists on a %i and stops probing for 5 minutes', async (status) => {
    const { api, reportDashboard, listOrders } = fakeApi({ dashboard: () => Promise.reject(new ApiError(status, 'not found')) })
    const first = await fetchDashboard(api, '7d', NOW)
    expect(first.kind).toBe('orders')
    expect(listOrders).toHaveBeenCalledTimes(2) // sale side + refund side
    expect(listOrders.mock.calls.map((c) => c[0].dateBasis)).toEqual([undefined, 'refund'])
    expect(reportDashboard).toHaveBeenCalledTimes(1)
    await fetchDashboard(api, '7d', NOW + 12_000)
    expect(reportDashboard).toHaveBeenCalledTimes(1) // remembered
    await fetchDashboard(api, '7d', NOW + AGGREGATE_REPROBE_MS + 1)
    expect(reportDashboard).toHaveBeenCalledTimes(2) // probed again
  })

  it('treats a 200 that is not an aggregate (generic answer for an unknown route) as a missing route', async () => {
    const { api, reportDashboard, listOrders } = fakeApi({ dashboard: () => Promise.resolve({ data: [], meta: {} } as unknown as DashboardAggregate) })
    expect((await fetchDashboard(api, 'today', NOW)).kind).toBe('orders')
    expect(listOrders).toHaveBeenCalledTimes(2)
    await fetchDashboard(api, 'today', NOW + 12_000)
    expect(reportDashboard).toHaveBeenCalledTimes(1)
  })

  it('picks the aggregate up once a backend deployed mid-session answers it', async () => {
    let deployed = false
    const { api } = fakeApi({ dashboard: () => (deployed ? Promise.resolve(agg) : Promise.reject(new ApiError(404, 'x'))) })
    expect((await fetchDashboard(api, 'today', NOW)).kind).toBe('orders')
    deployed = true
    expect((await fetchDashboard(api, 'today', NOW + AGGREGATE_REPROBE_MS + 1)).kind).toBe('aggregate')
  })

  it.each([
    ['500', new ApiError(500, 'boom')],
    ['network', new ApiError(0, 'offline', 'network')],
    ['403', new ApiError(403, 'forbidden')],
  ])('does not hide a %s behind the fallback (the screen keeps its numbers and shows the error)', async (_n, err) => {
    const { api, listOrders } = fakeApi({ dashboard: () => Promise.reject(err) })
    await expect(fetchDashboard(api, '30d', NOW)).rejects.toBe(err)
    expect(listOrders).not.toHaveBeenCalled()
  })

  it('an old backend that ignores dateBasis leaves the refund side null (completed-only numbers)', async () => {
    const plain = { id: 'o1', status: 'completed', total: 1 } as unknown as Order
    const { api } = fakeApi({ dashboard: () => Promise.reject(new ApiError(404, 'x')), refundRows: [plain] })
    const r = await fetchDashboard(api, 'today', NOW)
    expect(r).toMatchObject({ kind: 'orders', refund: null })
  })
})

describe('aggregate refresh cadence ("Semua" is a full scan: once a minute)', () => {
  beforeEach(() => resetAggregateProbe())

  it('is 60 s for Semua and the 12 s poll for every other period', () => {
    expect(aggregateRefreshMs('all')).toBe(60_000)
    for (const p of ['today', '7d', '30d'] as const) expect(aggregateRefreshMs(p)).toBe(DASHBOARD_POLL_MS)
    expect(DASHBOARD_POLL_MS).toBe(12_000)
  })

  it('Semua asks the server once per minute even though the screen polls every 12 s', async () => {
    const { api, reportDashboard } = fakeApi({})
    const kinds: string[] = []
    for (let t = 0; t <= 60_000; t += DASHBOARD_POLL_MS) kinds.push((await fetchDashboard(api, 'all', NOW + t, 'u1|o1')).kind)
    expect(kinds.every((k) => k === 'aggregate')).toBe(true)
    expect(reportDashboard).toHaveBeenCalledTimes(2) // at 0 s and at 60 s; 12/24/36/48 s were served from the last answer
    await fetchDashboard(api, 'all', NOW + 60_000 + 59_000, 'u1|o1')
    expect(reportDashboard).toHaveBeenCalledTimes(2)
    await fetchDashboard(api, 'all', NOW + 120_000, 'u1|o1')
    expect(reportDashboard).toHaveBeenCalledTimes(3)
  })

  it.each(['today', '7d', '30d'] as const)('%s keeps asking on every 12 s poll', async (period) => {
    const { api, reportDashboard } = fakeApi({})
    for (let i = 0; i < 5; i++) await fetchDashboard(api, period, NOW + i * DASHBOARD_POLL_MS, 'u1|o1')
    expect(reportDashboard).toHaveBeenCalledTimes(5)
  })

  it('never hands one scope, period or day the answer of another', async () => {
    const { api, reportDashboard } = fakeApi({})
    await fetchDashboard(api, 'all', NOW, 'u1|o1')
    await fetchDashboard(api, 'all', NOW + 1_000, 'u1|o2') // another outlet
    await fetchDashboard(api, 'all', NOW + 2_000, 'u2|o1') // another user
    expect(reportDashboard).toHaveBeenCalledTimes(3)
    await fetchDashboard(api, 'all', NOW + 24 * 3_600_000, 'u2|o1') // the next day: the window's end moved
    expect(reportDashboard).toHaveBeenCalledTimes(4)
    await fetchDashboard(api, '30d', NOW + 24 * 3_600_000, 'u2|o1') // another period (not throttled anyway)
    expect(reportDashboard).toHaveBeenCalledTimes(5)
  })

  it('does not remember a failure: the next poll asks again', async () => {
    let fail = true
    const { api, reportDashboard } = fakeApi({ dashboard: () => (fail ? Promise.reject(new ApiError(500, 'boom')) : Promise.resolve(agg)) })
    await expect(fetchDashboard(api, 'all', NOW, 'u1|o1')).rejects.toBeInstanceOf(ApiError)
    fail = false
    expect((await fetchDashboard(api, 'all', NOW + 12_000, 'u1|o1')).kind).toBe('aggregate')
    expect(reportDashboard).toHaveBeenCalledTimes(2)
  })

  it('the order-list fallback keeps its 12 s cadence for Semua', async () => {
    const { api, listOrders } = fakeApi({ dashboard: () => Promise.reject(new ApiError(404, 'x')) })
    for (let i = 0; i < 3; i++) expect((await fetchDashboard(api, 'all', NOW + i * DASHBOARD_POLL_MS, 'u1|o1')).kind).toBe('orders')
    expect(listOrders).toHaveBeenCalledTimes(6) // 3 polls x (sale + refund)
  })
})
