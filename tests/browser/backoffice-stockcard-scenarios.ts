// Kartu Stok (S1): the Ringkasan row opens the card, the saldo header and rows render, paging
// and the Hadiah chip reach the API as the right query, and Unduh CSV saves the server file
// (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { BO } from './fixture'

const OUTLET = '00000000-0000-4000-8f69-0000000000a1'
const PRODUCT = '00000000-0000-4000-8f69-0000000000c1'
const CSV = 'id,jenis,saldo\r\nmv-1,sale,-3\r\n'

const row = (seq: number, kind: string, qty: number, after: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8f69-00000000010${seq}`, seq, occurredAt: '2026-01-03T05:00:00Z', recordedAt: '2026-01-03T05:00:01Z',
  kind, locationType: 'outlet', locationId: OUTLET, locationName: 'MV Outlet', productId: PRODUCT, productName: 'Canvas Bag',
  variantSize: 'Std', sku: 'CB-STD', qty, qtyBefore: after - qty, qtyAfter: after, refType: 'order', refNumber: `INV-${seq}`,
  flags: [] as string[], isGiveaway: false, ...over,
})

const RECEIPT = row(1, 'receipt', 5, 5, { refType: 'goods_receipt', refNumber: undefined })
const SHORTAGE = row(2, 'sale', -7, -2, { flags: ['shortage'] })
const GIVEAWAY = row(3, 'sale', -1, -3, { isGiveaway: true, refNumber: 'INV-3' })
const SUMMARY = { opening: 0, totalIn: 5, totalOut: 8, closing: -3 }

export const stockCardFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
  const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
  const listCalls: URLSearchParams[] = []
  const summaryCalls: URLSearchParams[] = []
  const exportCalls: URLSearchParams[] = []

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/inventory/overview')) return route.fulfill({ json: { locations: [], rows: [] } })
    if (path.endsWith('/inventory/movements/summary')) {
      summaryCalls.push(url.searchParams)
      return route.fulfill({ json: {
        data: [{ productId: PRODUCT, productName: 'Canvas Bag', variantSize: 'Std', sku: 'CB-STD', opening: 0, closing: -3, inByKind: { receipt: 5 }, outByKind: { sale: 8 } }],
        meta: { total: 1, page: 1, limit: 25 },
      } })
    }
    if (path.endsWith('/inventory/movements/export')) {
      exportCalls.push(url.searchParams)
      return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV })
    }
    if (path.endsWith('/inventory/movements')) {
      const q = url.searchParams
      listCalls.push(q)
      if (q.get('giveaway') === 'true') return route.fulfill({ json: { data: [GIVEAWAY], summary: SUMMARY } })
      if (q.get('cursor') === 'c1') return route.fulfill({ json: { data: [RECEIPT] } })
      return route.fulfill({ json: { data: [GIVEAWAY, SHORTAGE], nextCursor: 'c1', summary: SUMMARY } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await page.goto(BO)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('mandalika.backoffice.refresh', 'SYNTHETIC-NON-TOKEN')
    localStorage.setItem('mandalika.backoffice.loginDate', new Date().toLocaleDateString('sv-SE'))
  })
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 1000 })

  await page.getByRole('button', { name: 'Inventori', exact: true }).click()
  await page.getByRole('button', { name: 'Pergerakan', exact: true }).click()
  const summaryRow = page.getByRole('row', { name: /Canvas Bag/ })
  await summaryRow.waitFor()
  check(summaryCalls.some((q) => q.get('locationType') === 'outlet' && q.get('locationId') === OUTLET && !!q.get('from') && !!q.get('to')), 'summary query')
  results.push({ step: 'ringkasan', calls: summaryCalls.length })

  await summaryRow.click()
  await page.getByText('Canvas Bag · Std (CB-STD)').first().waitFor()
  await page.getByText('Saldo Akhir').first().waitFor()
  await page.getByText('Hadiah', { exact: true }).nth(1).waitFor() // the row badge, next to the chip
  await page.getByText('Minus', { exact: true }).nth(1).waitFor()
  const first = listCalls.find((q) => !q.get('cursor') && !q.get('giveaway'))
  check(!!first && first.get('productId') === PRODUCT && first.get('variantSize') === 'Std' && first.get('locationId') === OUTLET, 'card query')
  results.push({ step: 'card-opens-on-sku', query: first?.toString() })

  await page.getByRole('button', { name: 'Muat lebih banyak' }).click()
  await page.getByText('goods_receipt', { exact: true }).waitFor()
  check(listCalls.some((q) => q.get('cursor') === 'c1'), 'cursor sent')
  await page.getByRole('button', { name: 'Muat lebih banyak' }).waitFor({ state: 'detached' })
  results.push({ step: 'paging', rows: 3 })

  await page.getByRole('button', { name: 'Hadiah', exact: true }).click()
  await page.getByText('goods_receipt', { exact: true }).waitFor({ state: 'detached' })
  check(listCalls.some((q) => q.get('giveaway') === 'true'), 'giveaway filter sent')
  results.push({ step: 'giveaway-chip' })

  const waiting = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Unduh CSV' }).click()
  const download = await waiting
  const chunks: Buffer[] = []
  for await (const chunk of (await download.createReadStream()) as AsyncIterable<Buffer>) chunks.push(chunk)
  const saved = Buffer.concat(chunks).toString('utf8')
  check(download.suggestedFilename().startsWith('kartu-stok_') && saved.includes('mv-1,sale,-3'), `download ${download.suggestedFilename()}`)
  check(exportCalls.length === 1 && exportCalls[0].get('giveaway') === 'true' && !!exportCalls[0].get('from') && !!exportCalls[0].get('to'), 'export query')
  results.push({ step: 'csv', file: download.suggestedFilename() })
  return results
}
