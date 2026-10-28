// C4c backoffice refunds: Laporan > Refund (rows, flag filter, paging, per-refund CSV) and the admin per-line
// refund on Transaksi (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { BO } from './fixture'

const OUTLET = '00000000-0000-4000-8f69-0000000000a1'
const uuid = (n: number) => `00000000-0000-4000-8f69-${String(n).padStart(12, '0')}`
const NOW = '2026-01-03T05:00:00Z'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

const login = async (page: ScenarioPage) => {
  await page.goto(BO)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('mandalika.backoffice.refresh', 'SYNTHETIC-NON-TOKEN')
    localStorage.setItem('mandalika.backoffice.loginDate', new Date().toLocaleDateString('sv-SE'))
  })
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 1000 })
}

const EMPTY_SUMMARY = {
  from: null, to: null, outletId: null, totalSales: 0, totalOrders: 0, grossSales: 0, grossOrders: 0, totalRefunds: 0, refundedOrders: 0,
  netSales: 0, avgOrderValue: 0, byPaymentMethod: {}, grossByPaymentMethod: {}, refundsByPaymentMethod: {}, topProducts: [], dailySales: [],
}

// Routes every Laporan hub load needs; true when it answered the request.
const hubRoutes = async (route: any, path: string): Promise<boolean> => {
  if (path.includes('/auth/')) { await route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } }); return true }
  if (path.endsWith('/outlets')) { await route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } }); return true }
  if (path.endsWith('/settings/app')) { await route.fulfill({ json: { data: { paymentMethods: [{ id: 'cash', label: 'Tunai' }] } } }); return true }
  if (path.endsWith('/reports/summary')) { await route.fulfill({ json: { data: EMPTY_SUMMARY } }); return true }
  return false
}

const refundRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(500 + n), orderId: uuid(600 + n), orderNumber: `INV-F-${n}`, outletId: OUTLET, outletName: 'MV Outlet', cashierName: 'Kasir Dua',
  seq: 1, scope: 'full', amount: 10000, computedAmount: 10000, claimedAmount: null, amountWarning: null, paymentMethod: 'cash', reason: 'Rusak/cacat',
  reasonCode: 'rusak_cacat', refundedByName: 'MV Admin', refundedAt: NOW, refundBusinessDate: '2026-01-03',
  items: [{ orderItemId: uuid(700 + n), lineNo: 0, productName: 'Filler', variantSize: '', quantity: 1, amount: 10000 }], ...over,
})
const PARTIAL = refundRow(1, {
  id: uuid(401), orderNumber: 'INV-R-1001', seq: 2, scope: 'partial', amount: 50000, computedAmount: 50000, claimedAmount: 80000, amountWarning: 'over_total',
  reason: 'Salah varian', reasonCode: 'salah_varian', items: [{ orderItemId: uuid(411), lineNo: 0, productName: 'Canvas Bag', variantSize: 'Std', quantity: 1, amount: 50000 }],
})
const FULL = refundRow(2, { id: uuid(402), orderNumber: 'INV-R-1002', amount: 120000, computedAmount: 120000, items: [{ orderItemId: uuid(412), lineNo: 0, productName: 'Parfum Kayu', variantSize: '', quantity: 2, amount: 120000 }] })
// 60 refunds so the 50-row page size pages; the filler rows carry no warning.
const ALL_REFUNDS = [PARTIAL, FULL, ...Array.from({ length: 58 }, (_, i) => refundRow(i + 3, { id: uuid(420 + i) }))]

export const refundReportFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const calls: URLSearchParams[] = []

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (await hubRoutes(route, path)) return
    if (path.endsWith('/refund-report')) {
      const q = url.searchParams
      calls.push(q)
      const pageNo = Number(q.get('page') ?? 1), limit = Number(q.get('limit') ?? 50)
      const flag = q.get('flag')
      const set = ALL_REFUNDS.filter((r) => !flag || (flag === 'any' ? !!r.amountWarning : r.amountWarning === flag))
      return route.fulfill({ json: {
        summary: { count: set.length, totalAmount: set.reduce((s, r) => s + r.amount, 0), flaggedCount: set.filter((r) => !!r.amountWarning).length },
        data: set.slice((pageNo - 1) * limit, pageNo * limit), meta: { total: set.length, page: pageNo, limit },
      } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await login(page)

  await page.getByRole('button', { name: 'Laporan', exact: true }).click()
  await page.getByRole('button', { name: 'Refund', exact: true }).click()

  const partial = page.getByRole('row', { name: /INV-R-1001/ })
  await partial.waitFor()
  await partial.getByText('Refund ke-2').waitFor()
  await partial.getByText('Sebagian', { exact: true }).waitFor()
  const partialText = await partial.innerText()
  check(/50\.000/.test(partialText) && /80\.000/.test(partialText), 'amount of record and claimed amount')
  await partial.getByText('Melebihi total', { exact: true }).waitFor()
  const full = page.getByRole('row', { name: /INV-R-1002/ })
  await full.getByText('Refund ke-1').waitFor()
  await full.getByText('Penuh', { exact: true }).waitFor()
  const fullText = await full.innerText()
  check(/120\.000/.test(fullText) && !/Melebihi|Jumlah beda/.test(fullText), 'full refund row has no claim and no warning')
  await page.getByText('Ada Peringatan', { exact: true }).waitFor()
  results.push({ step: 'rows' })

  // paging reaches the API
  check(calls.some((q) => q.get('page') === '1' && q.get('limit') === '50'), 'first page query')
  await page.getByRole('button', { name: /Berikutnya/ }).click()
  await page.getByRole('row', { name: /INV-F-52/ }).waitFor()
  check(calls.some((q) => q.get('page') === '2' && q.get('limit') === '50'), 'page 2 query')
  await page.getByRole('button', { name: /Sebelumnya/ }).click()
  await partial.waitFor()
  results.push({ step: 'paging' })

  // per-refund CSV pages the filtered set at limit=200
  const waiting = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export Refund CSV' }).click()
  const download = await waiting
  const chunks: Buffer[] = []
  for await (const chunk of (await download.createReadStream()) as AsyncIterable<Buffer>) chunks.push(chunk)
  const lines = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').split('\r\n')
  check(download.suggestedFilename().startsWith('laporan-refund_'), `download name ${download.suggestedFilename()}`)
  check(lines[0] === 'No. struk,Refund ke-,Waktu,Hari refund,Item,Qty,Jumlah,Jumlah diklaim,Metode,Oleh,Kasir,Outlet,Alasan,Kode alasan,Peringatan jumlah', `csv header ${lines[0]}`)
  check(lines.length === 61, `csv has one row per refund (${lines.length - 1})`)
  check(lines[1].startsWith('INV-R-1001,2,') && lines[1].includes('Canvas Bag (Std) ×1,1,50000,80000,cash,MV Admin,Kasir Dua,MV Outlet,Salah varian,salah_varian,Melebihi total'), `csv partial row ${lines[1]}`)
  check(lines[2].includes('Parfum Kayu ×2,2,120000,,cash'), `csv full row ${lines[2]}`)
  check(calls.some((q) => q.get('limit') === '200' && q.get('page') === '1'), 'csv pages at limit 200')
  results.push({ step: 'csv', file: download.suggestedFilename() })

  // the flag select is a server filter
  await page.locator('select').filter({ hasText: 'Ada peringatan' }).selectOption('over_total')
  await page.getByRole('row', { name: /INV-R-1002/ }).waitFor({ state: 'detached' })
  await partial.waitFor()
  check(calls.some((q) => q.get('flag') === 'over_total' && q.get('page') === '1'), 'flag query')
  results.push({ step: 'flag-filter' })
  return results
}

const itemId = (n: number) => uuid(800 + n)
const line = (lineNo: number, name: string, qty: number, net: number, over: Record<string, unknown> = {}) => ({
  id: itemId(lineNo), lineNo, productId: uuid(900 + lineNo), productName: name, variantSize: '', quantity: qty, unitPrice: net / qty, price: net / qty,
  subtotal: net, netAmount: net, refundedQty: 0, ...over,
})

export const adminPartialRefundFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let refunded = false

  const order = () => ({
    id: uuid(1000), orderNumber: 'INV-R-2001', outletId: OUTLET, cashierId: 'c1', cashierName: 'Kasir Dua', customerId: null, customerName: null,
    status: refunded ? 'partially_refunded' : 'completed', paymentMethod: 'cash', subtotal: 450000, discountAmount: 0, taxAmount: 0, total: 450000, change: 0,
    createdAt: NOW, ...(refunded ? { refundedAmount: 100000 } : {}),
    items: [
      line(0, 'Parfum A', 2, 200000, { refundedQty: refunded ? 1 : 0 }),
      line(1, 'Parfum B', 1, 150000),
      line(2, 'Paket Satu', 1, 50000, { refundGroup: 'g1' }),
      line(3, 'Paket Dua', 1, 50000, { refundGroup: 'g1' }),
    ],
    refunds: refunded ? [{
      id: uuid(1100), seq: 1, scope: 'partial', amount: 100000, computedAmount: 100000, claimedAmount: null, amountWarning: null, paymentMethod: 'cash',
      reason: 'Rusak/cacat', reasonCode: 'rusak_cacat', refundedByName: 'MV Admin', refundedAt: NOW, refundBusinessDate: '2026-01-03',
      items: [{ orderItemId: itemId(0), lineNo: 0, quantity: 1, amount: 100000 }],
    }] : [],
  })

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (await hubRoutes(route, path)) return
    if (path.endsWith('/refund') && req.method() === 'POST') {
      posts.push({ path, body: JSON.parse(req.postData() ?? '{}') as Record<string, unknown> })
      refunded = true
      return route.fulfill({ json: { data: order() } })
    }
    if (path.endsWith('/orders')) return route.fulfill({ json: { data: [order()], meta: { total: 1, page: 1, limit: 50 } } })
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await login(page)

  await page.getByRole('button', { name: 'Laporan', exact: true }).click()
  await page.getByRole('button', { name: /INV-R-2001/ }).click()
  await page.getByRole('button', { name: 'Proses Refund' }).click()

  // a bundle group is all-or-nothing: one tap selects both members, lowering one clears both
  await page.getByText('Satu paket: dipilih bersama').first().waitFor()
  await page.getByRole('button', { name: /^Tambah Paket Satu/ }).click()
  check((await page.getByLabel(/^Jumlah Paket Dua/).innerText()) === '1', 'bundle partner selected with it')
  await page.getByRole('button', { name: /^Kurangi Paket Dua/ }).click()
  check((await page.getByLabel(/^Jumlah Paket Satu/).innerText()) === '0', 'bundle cleared together')
  results.push({ step: 'bundle-all-or-nothing' })

  await page.getByRole('button', { name: /^Tambah Parfum A/ }).click()
  check((await page.getByLabel(/^Jumlah Parfum A/).innerText()) === '1', 'qty 1 picked')
  await page.locator('select').filter({ hasText: 'Pilih alasan' }).selectOption('rusak_cacat')
  await page.getByRole('button', { name: 'Lanjut', exact: true }).click()
  await page.getByRole('heading', { name: 'Konfirmasi refund' }).waitFor()
  await page.getByRole('listitem').filter({ hasText: /^Parfum A ×1$/ }).waitFor()
  check(/100\.000/.test(await page.getByText(/Perkiraan jumlah refund/).innerText()), 'estimate is half of line 0')
  results.push({ step: 'confirm-modal' })

  // the confirm button sits after the Laporan "Refund" tab in the DOM
  await page.getByRole('button', { name: 'Refund', exact: true }).last().click()
  await page.getByText('Refund ke-1').waitFor()
  check(posts.length === 1 && posts[0].path.endsWith(`/orders/${uuid(1000)}/refund`), 'one refund post to the order')
  const body = posts[0].body as { clientRefundUuid?: string }
  check(/^[0-9a-f-]{36}$/.test(body.clientRefundUuid ?? ''), `refund body carries a replay uuid ${JSON.stringify(body)}`)
  const { clientRefundUuid: _uuid, ...rest } = posts[0].body as Record<string, unknown>
  check(JSON.stringify(rest) === JSON.stringify({ reason: 'Rusak/cacat', reasonCode: 'rusak_cacat', items: [{ lineNo: 0, quantity: 1 }] }), `refund body ${JSON.stringify(posts[0].body)}`)
  await page.getByText('Refund sebagian').waitFor()
  await page.getByText(/Sisa bisa direfund/).filter({ hasText: '350.000' }).waitFor()
  await page.getByText(/Total direfund/).filter({ hasText: '100.000' }).waitFor()
  results.push({ step: 'after-refund', body: posts[0].body })
  return results
}
