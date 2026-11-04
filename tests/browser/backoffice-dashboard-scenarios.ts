// Ringkasan reads the server aggregate: one small request per 12 s poll instead of every order of the period (sale and
// refund side), and the same numbers on the screen. A backend without the route (404) falls back to the old client math.
// Synthetic API; a Playwright fake clock drives the idle time.
import type { ScenarioPage } from './fixture'
import { openBackoffice, deepLink } from './fixture'

const OUTLET = '00000000-0000-4000-8f6c-0000000000a1'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const settings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: false,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
}

interface Counts { aggregate: number; saleOrders: number; refundOrders: number; lastParams: Record<string, string> }

/** Three completed orders of Rp 100.000 each, today (the order lists the fallback computes from). */
const order = (i: number) => ({
  id: `order-${i}`, orderNumber: `DAG-${i}`, outletId: OUTLET, cashierId: user.id, cashierName: user.displayName, customerId: null, customerName: null,
  status: 'completed', paymentMethod: 'qris', subtotal: 100000, total: 100000, discountAmount: 0, taxAmount: 0,
  createdAt: new Date().toISOString(), businessDate: new Date().toISOString().slice(0, 10),
  items: [{ productId: 'p-1', productName: 'Parfum A', variantSize: '30ml', quantity: 1, subtotal: 100000, unitPrice: 100000 }],
})

/** What the server answers for those three orders. */
const aggregate = () => ({
  current: { gross: 300000, grossCount: 3, refunds: 0, refundedCount: 0, net: 300000, orders: 3, itemsSold: 3, customers: 0, stillSoldRevenue: 300000 },
  previous: { gross: 0, grossCount: 0, refunds: 0, refundedCount: 0, net: 0, orders: 0, itemsSold: 0, customers: 0, stillSoldRevenue: 0 },
  trend: [], grossByPaymentMethod: { qris: 300000 }, refundsByPaymentMethod: {},
  topProducts: [{ productId: 'p-1', productName: 'Parfum A', variantSize: '30ml', qty: 3 }],
  bottomProducts: [{ productId: 'p-1', productName: 'Parfum A', variantSize: '30ml', qty: 3 }],
  distinctProducts: 1, cashiers: [{ id: user.id, name: user.displayName, transactions: 3, revenue: 300000 }], promoTally: [],
})

async function mockApi(page: ScenarioPage, aggregateRoute: 'serve' | 'missing'): Promise<Counts> {
  const counts: Counts = { aggregate: 0, saleOrders: 0, refundOrders: 0, lastParams: {} }
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api/v1', '')
    const pageNo = Number(url.searchParams.get('page')) || 1
    const limit = Number(url.searchParams.get('limit')) || 50
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value })
    const paged = (rows: unknown[]) => json({ data: rows.slice((pageNo - 1) * limit, pageNo * limit), meta: { total: rows.length, page: pageNo, limit } })
    if (path.includes('/auth/')) return json({ data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } })
    if (path === '/outlets') return json({ data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] })
    if (path === '/settings/app') return json({ data: settings })
    if (path === '/reports/dashboard') {
      counts.aggregate++
      counts.lastParams = Object.fromEntries(url.searchParams.entries())
      return aggregateRoute === 'serve' ? json({ data: aggregate() }) : json({ error: 'not found' }, 404)
    }
    if (path === '/orders') {
      if (pageNo === 1) {
        if (url.searchParams.get('dateBasis') === 'refund') counts.refundOrders++
        else counts.saleOrders++
      }
      return url.searchParams.get('dateBasis') === 'refund' ? paged([]) : paged([1, 2, 3].map(order))
    }
    return paged([])
  })
  return counts
}

/** Fire the app's timers for `ms` of fake time in steps, letting each poll's responses land before the next step. */
async function idle(page: ScenarioPage, ms: number) {
  for (let spent = 0; spent < ms; spent += 10_000) {
    await page.clock.runFor(10_000)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(300)
}

const kpi = async (page: ScenarioPage, label: string) =>
  (await page.locator('p', { hasText: new RegExp(`^${label}$`) }).locator('xpath=preceding-sibling::p[1]').innerText()).replace(/\s/g, '')

async function openRingkasan(page: ScenarioPage) {
  await page.clock.install()
  await openBackoffice(page)
  await page.waitForTimeout(600)
  await deepLink(page, '#/ringkasan')
  await page.getByText('Penjualan', { exact: true }).first().waitFor()
  await page.waitForFunction(() => /Rp300\.000/.test(document.body.innerText.replace(/\s/g, '')))
}

export const dashboardAggregateFlow = async (page: ScenarioPage) => {
  const results: object[] = []

  // (a) the aggregate route answers: the screen reads it, never lists a single order, and keeps its 12 s refresh.
  const served = await mockApi(page, 'serve')
  await openRingkasan(page)
  check(served.aggregate >= 1, 'Ringkasan asked for the aggregate')
  check(served.saleOrders === 0 && served.refundOrders === 0, `no order list is downloaded, got sale ${served.saleOrders} refund ${served.refundOrders}`)
  check(!!served.lastParams.dateTo && !!served.lastParams.dateFrom && !!served.lastParams.prevDateFrom && served.lastParams.trend === 'day', `the default 7-day windows are sent, got ${JSON.stringify(served.lastParams)}`)
  const before = served.aggregate
  check((await kpi(page, 'Penjualan')) === 'Rp300.000' && (await kpi(page, 'Transaksi')) === '3', 'Penjualan Rp 300.000 and Transaksi 3 from the aggregate')
  await page.getByText('Parfum A', { exact: false }).first().waitFor()
  await idle(page, 30_000)
  check(served.aggregate >= before + 2, `the aggregate keeps its 12 s refresh: ${before} -> ${served.aggregate}`)
  check(served.saleOrders === 0 && served.refundOrders === 0, 'still no order list after 30 s')
  check((await kpi(page, 'Penjualan')) === 'Rp300.000', 'Penjualan unchanged after the polls')
  results.push({ step: 'aggregate-one-request-per-poll', aggregate: served.aggregate })

  // (b) an older backend answers 404: the same numbers from the order lists, probed once, then the old cadence.
  const missing = await mockApi(page, 'missing')
  await page.reload()
  await page.getByText('Penjualan', { exact: true }).first().waitFor()
  await page.waitForFunction(() => /Rp300\.000/.test(document.body.innerText.replace(/\s/g, '')))
  check((await kpi(page, 'Penjualan')) === 'Rp300.000' && (await kpi(page, 'Transaksi')) === '3', 'the fallback shows the same Penjualan and Transaksi')
  // The mount and the outlet-resolved re-run can both probe before the first 404 is remembered; never more than that.
  const probes = missing.aggregate
  check(probes >= 1 && probes <= 2, `the missing route is probed at most twice at load, got ${probes}`)
  const sales = missing.saleOrders
  await idle(page, 30_000)
  check(missing.aggregate === probes, `no further probe inside the re-probe window: ${probes} -> ${missing.aggregate}`)
  check(missing.saleOrders >= sales + 2 && missing.refundOrders >= 2, `the order lists keep their 12 s poll: sale ${sales} -> ${missing.saleOrders}`)
  check((await kpi(page, 'Penjualan')) === 'Rp300.000', 'Penjualan unchanged in the fallback')
  results.push({ step: 'fallback-on-404', probes, sales: missing.saleOrders })

  return results
}
