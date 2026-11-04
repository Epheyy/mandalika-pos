// Ringkasan parity (docs/plans/2026-11-04-ringkasan-dashboard-aggregate.md, section 7). The fixture in
// tests/fixtures/dashboard-parity is shared with the Go gate TestDashboardAggregatePostgres:
//   list-dumps.json         what the real GET /orders returned for the calls Dashboard makes (Go gate asserts it)
//   expected-aggregate.json what the real GET /reports/dashboard returned (Go gate asserts it)
//   expected-view.json      today's metrics.ts over the dumps (frozen here; UPDATE_DASHBOARD_PARITY=1 rewrites it)
// Chain: metrics.ts(dumps) == expected-view == viewFromAggregate(expected-aggregate).
process.env.TZ = 'Asia/Jakarta' // metrics.ts computes in the browser's local zone; must be set before any Date use

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DashboardAggregate, Order, Promotion } from '@mandalika/api'
import { dashboardAggregateParams, viewFromAggregate, viewFromOrders, type DashboardView } from './dashboardView'
import { dashboardFetchWindow, refundSideOrNull, type Period } from './metrics'

const dir = fileURLToPath(new URL('../../../../../tests/fixtures/dashboard-parity/', import.meta.url))
const load = <T>(name: string): T => JSON.parse(readFileSync(dir + name, 'utf8')) as T
const update = process.env.UPDATE_DASHBOARD_PARITY === '1'

interface Scenario {
  name: string
  now: string
  period: Period
  scope: string
  params: Record<string, string | number>
  ordersWindow: { dateFrom?: string; dateTo?: string }
}
const { scenarios } = load<{ scenarios: Scenario[] }>('scenarios.json')
const seed = load<{ promotions: string[] }>('seed.json')
const dumps = load<Record<string, Order[]>>('list-dumps.json')
const aggregates = load<Record<string, DashboardAggregate>>('expected-aggregate.json')
const promotions = seed.promotions.map((name) => ({ name }) as Promotion)

const dumpKey = (s: Scenario, basis: 'sale' | 'refund') =>
  `${s.scope}|${s.ordersWindow.dateFrom ?? ''}|${s.ordersWindow.dateTo ?? ''}|${basis}`

/** Money and percentages compared at cent precision; everything else exactly. */
function canon<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v), (_k, x: unknown) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x))
}

const views: Record<string, DashboardView> = {}
for (const s of scenarios) {
  const now = new Date(s.now)
  views[s.name] = viewFromOrders(dumps[dumpKey(s, 'sale')], refundSideOrNull(dumps[dumpKey(s, 'refund')]), s.period, now, promotions)
}
if (update) writeFileSync(dir + 'expected-view.json', JSON.stringify(canon(views), null, 1) + '\n')
const expectedViews = load<Record<string, unknown>>('expected-view.json')

describe('Ringkasan dashboard parity', () => {
  it('runs in the Jakarta zone the fixture was cut for', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-420)
  })

  it('the fixture dumps are self-consistent (refundedAmount, refundedQty and refunds[] agree)', () => {
    for (const orders of Object.values(dumps)) {
      for (const o of orders) {
        const refunds = o.refunds ?? []
        expect(o.refundedAmount ?? 0).toBeCloseTo(refunds.reduce((sum, r) => sum + r.amount, 0), 2)
        for (const it of o.items) {
          const returned = refunds.flatMap((r) => r.items).filter((x) => x.orderItemId === it.id).reduce((sum, x) => sum + x.quantity, 0)
          expect(it.refundedQty ?? 0).toBe(returned)
        }
      }
    }
  })

  for (const s of scenarios) {
    describe(s.name, () => {
      const now = new Date(s.now)

      it('sends the windows the Go gate was run with', () => {
        expect(dashboardAggregateParams(s.period, now)).toEqual(s.params)
        expect(dashboardFetchWindow(s.period, now)).toEqual(s.ordersWindow)
      })

      it('the refund list is a supported answer (not an old backend ignoring dateBasis)', () => {
        expect(refundSideOrNull(dumps[dumpKey(s, 'refund')])).not.toBeNull()
      })

      it("today's metrics.ts over the real order lists == the frozen view", () => {
        expect(canon(views[s.name])).toEqual(expectedViews[s.name])
      })

      it('the server aggregate maps to the same view, number for number', () => {
        expect(canon(viewFromAggregate(aggregates[s.name], s.period, now, promotions))).toEqual(expectedViews[s.name])
      })
    })
  }
})
