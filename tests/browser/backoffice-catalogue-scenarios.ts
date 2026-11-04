// Shared product-catalogue cache: the screens that need the whole product list read it once per outlet scope instead of
// reloading every page on the 12 s poll. Synthetic API; a Playwright fake clock drives the idle time.
import type { ScenarioPage } from './fixture'
import { openBackoffice, deepLink } from './fixture'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const settings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: false,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
}

interface Counts { productLoads: number; saleOrderLoads: number; refundOrderLoads: number; stockCountLoads: number; customerLoads: number; created: any[] }
interface MockState { counts: Counts; stock: number }

/** Three completed orders of Rp 100.000 each, today: Ringkasan's Penjualan must read Rp 300.000 before and after every poll. */
const order = (i: number) => ({
  id: `order-${i}`, orderNumber: `CAT-${i}`, outletId: OUTLET, cashierId: user.id, cashierName: user.displayName, customerId: null, customerName: null,
  status: 'completed', paymentMethod: i % 2 ? 'qris' : 'cash', subtotal: 100000, total: 100000, discountAmount: 0, taxAmount: 0,
  createdAt: new Date().toISOString(), items: [{ productId: 'p-1', productName: 'Parfum A', variantSize: '30ml', quantity: 1, subtotal: 100000, unitPrice: 100000 }],
})

const productRows = (stock: number) => Array.from({ length: 201 }, (_, i) => ({
  id: `p-${i + 1}`, name: `Parfum ${i + 1}`, isActive: true, variants: [{ size: '30ml', sku: `SKU-${i + 1}`, price: 100000, stock: i === 0 ? stock : 50 }],
}))

async function mockApi(page: ScenarioPage): Promise<MockState> {
  const state: MockState = { stock: 7, counts: { productLoads: 0, saleOrderLoads: 0, refundOrderLoads: 0, stockCountLoads: 0, customerLoads: 0, created: [] } }
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api/v1', '')
    const method = request.method()
    const pageNo = Number(url.searchParams.get('page')) || 1
    const limit = Number(url.searchParams.get('limit')) || 50
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value })
    const paged = (rows: unknown[]) => json({ data: rows.slice((pageNo - 1) * limit, pageNo * limit), meta: { total: rows.length, page: pageNo, limit } })
    if (path.includes('/auth/')) return json({ data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } })
    if (path === '/outlets') return json({ data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] })
    if (path === '/settings/app') return json({ data: settings })
    if (path === '/products' && method === 'GET') {
      if (pageNo === 1) state.counts.productLoads++
      return paged(productRows(state.stock))
    }
    if (path === '/orders' && method === 'GET') {
      if (pageNo === 1) {
        if (url.searchParams.get('dateBasis') === 'refund') state.counts.refundOrderLoads++
        else state.counts.saleOrderLoads++
      }
      return url.searchParams.get('dateBasis') === 'refund' ? paged([]) : paged([1, 2, 3].map(order))
    }
    if (path === '/stock-counts' && method === 'GET') {
      if (pageNo === 1) state.counts.stockCountLoads++
      return paged([])
    }
    if (path === '/stock-counts' && method === 'POST') {
      state.counts.created.push(request.postDataJSON())
      return json({ data: { id: 'sc-new', name: 'x', status: 'planned', items: [] } })
    }
    if (path === '/customers' && method === 'GET') {
      if (pageNo === 1) state.counts.customerLoads++
      return paged([])
    }
    if (path === '/settings/loyalty') return json({ data: { enabled: false, earnRate: 0, redeemRate: 0 } })
    return paged([])
  })
  return state
}

/** Fire the app's timers for `ms` of fake time in steps, letting each poll's responses land before the next step. */
async function idle(page: ScenarioPage, ms: number) {
  for (let spent = 0; spent < ms; spent += 10_000) {
    await page.clock.runFor(10_000)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(300)
}

export const catalogueIdleFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const live = await mockApi(page)
  const counts = live.counts
  await page.clock.install()
  await openBackoffice(page)
  // (a) Opname: once the screen has loaded, 30 s of idle (two-plus polls of its own list) loads no catalogue again.
  //     (deepLink sets the hash and then reloads, so the page is measured only after the reload has settled.)
  await page.waitForTimeout(600)
  await deepLink(page, '#/inventori/opname')
  await page.getByRole('heading', { name: 'Opname Produk' }).waitFor()
  await page.waitForTimeout(600)
  const base = counts.productLoads
  const listsBefore = counts.stockCountLoads
  await idle(page, 30_000)
  check(counts.stockCountLoads >= listsBefore + 2, `the Opname list kept polling (12 s): ${listsBefore} -> ${counts.stockCountLoads}`)
  check(counts.productLoads === base, `30 s idle on Opname does not reload the catalogue, got ${counts.productLoads - base} more loads`)
  results.push({ step: 'opname-idle-no-catalogue-reload', productLoads: counts.productLoads - base, listLoads: counts.stockCountLoads })

  // (b) Tambah opname snapshots stock from a FRESH read: stock moved 7 -> 3 since the cache filled, frozenQty must be 3.
  live.stock = 3
  const loadsBeforeCreate = counts.productLoads
  await page.getByRole('button', { name: 'Tambah opname' }).first().click()
  await page.getByLabel('Nama *').fill('Opname Segar')
  await page.getByLabel('Lokasi *').selectOption(`o:${OUTLET}`)
  await page.getByRole('button', { name: 'Tambah opname', exact: true }).last().click()
  await page.waitForFunction(() => document.body.innerText.length > 0)
  for (let i = 0; i < 40 && counts.created.length === 0; i++) await page.waitForTimeout(100)
  check(counts.created.length === 1, 'one stock count was created')
  const lines = counts.created[0].items as { productId: string; frozenQty: number }[]
  check(counts.productLoads === loadsBeforeCreate + 1, `creating reads the catalogue fresh once, got ${counts.productLoads - loadsBeforeCreate}`)
  check(lines.length === 201 && lines.find((l) => l.productId === 'p-1')?.frozenQty === 3, `the snapshot carries the live stock (3), got ${JSON.stringify(lines[0])}`)
  results.push({ step: 'create-snapshots-fresh-stock', frozenQty: lines[0].frozenQty })

  // (c) Ringkasan: the order numbers keep polling and read the same; the catalogue is loaded once, not every 12 s.
  live.stock = 7
  await page.waitForTimeout(300)
  await deepLink(page, '#/ringkasan')
  await page.getByText('Penjualan', { exact: true }).first().waitFor()
  const kpi = async () => (await page.locator('p', { hasText: /^Penjualan$/ }).locator('xpath=preceding-sibling::p[1]').innerText()).replace(/\s/g, '')
  await page.waitForFunction(() => /Rp300\.000/.test(document.body.innerText.replace(/\s/g, '')))
  const first = await kpi()
  await page.waitForTimeout(300)
  const dash = { products: counts.productLoads, sales: counts.saleOrderLoads, refunds: counts.refundOrderLoads }
  await idle(page, 30_000)
  check(counts.saleOrderLoads >= dash.sales + 2 && counts.refundOrderLoads >= dash.refunds + 2, `the order numbers keep their 12 s poll: sale ${dash.sales} -> ${counts.saleOrderLoads}, refund ${dash.refunds} -> ${counts.refundOrderLoads}`)
  check(counts.productLoads - dash.products === 0, `30 s on Ringkasan does not reload the catalogue (loaded ${counts.productLoads - dash.products} more times)`)
  check((await kpi()) === first && first === 'Rp300.000', `Penjualan reads Rp 300.000 before and after the polls, got ${first} then ${await kpi()}`)
  // The low-stock card is bounded stale, not frozen: after the 60 s window the list is read again.
  await idle(page, 60_000)
  check(counts.productLoads - dash.products >= 1 && counts.productLoads - dash.products <= 2, `Ringkasan refreshes the catalogue once its minute is up, got ${counts.productLoads - dash.products}`)
  results.push({ step: 'ringkasan-orders-poll-catalogue-cached', sales: counts.saleOrderLoads, productLoads: counts.productLoads })

  // (d) Pelanggan: the loyalty product picker is behind a form, so idle on the list loads no catalogue at all.
  await page.waitForTimeout(300)
  const productsBefore = counts.productLoads
  await deepLink(page, '#/pelanggan')
  await page.getByRole('heading', { name: 'Pelanggan', exact: true }).first().waitFor()
  await page.waitForTimeout(400)
  const customersBefore = counts.customerLoads
  await idle(page, 30_000)
  check(counts.customerLoads >= customersBefore + 2, `the Pelanggan list kept polling: ${customersBefore} -> ${counts.customerLoads}`)
  check(counts.productLoads === productsBefore, `Pelanggan does not walk the catalogue while idle (loaded ${counts.productLoads - productsBefore} more times)`)
  results.push({ step: 'pelanggan-idle-no-catalogue', customerLoads: counts.customerLoads })

  return results
}
