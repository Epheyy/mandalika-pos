// Kartu Stok (S1, D3a): the Ringkasan row opens the card (its SKU and location ride in the URL), the saldo header
// and rows render, paging and the Hadiah chip reach the API as the right query, Unduh CSV saves the server file,
// and the two stock writes (Barang Masuk, Penyesuaian Stok) each send one Idempotency-Key per open
// (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { openBackoffice, openTab } from './fixture'

const OUTLET = '00000000-0000-4000-8f69-0000000000a1'
const PRODUCT = '00000000-0000-4000-8f69-0000000000c1'
const RECEIPT_ID = '00000000-0000-4000-8f69-0000000000f8'
const CSV = 'id,jenis,saldo\r\nmv-1,sale,-3\r\n'

const row = (seq: number, kind: string, qty: number, after: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8f69-00000000010${seq}`, seq, occurredAt: '2026-01-03T05:00:00Z', recordedAt: '2026-01-03T05:00:01Z',
  kind, locationType: 'outlet', locationId: OUTLET, locationName: 'MV Outlet', productId: PRODUCT, productName: 'Canvas Bag',
  variantSize: 'Std', sku: 'CB-STD', qty, qtyBefore: after - qty, qtyAfter: after, refType: 'order', refNumber: `INV-${seq}`,
  flags: [] as string[], isGiveaway: false, ...over,
})

const RECEIPT = row(1, 'receipt', 5, 5, { refType: 'goods_receipt', refId: RECEIPT_ID, refNumber: undefined, isWarranty: true })
// an offline sale: occurred on Jan 3, recorded on Jan 5 (the late badge)
const SHORTAGE = row(2, 'sale', -7, -2, { flags: ['shortage'], recordedAt: '2026-01-05T02:00:00Z' })
const GIVEAWAY = row(3, 'sale', -1, -3, { isGiveaway: true, refNumber: 'INV-3' })
const SUMMARY = { opening: 0, totalIn: 5, totalOut: 8, closing: -3 }

export const stockCardFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
  const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
  const listCalls: URLSearchParams[] = []
  const summaryCalls: URLSearchParams[] = []
  const exportCalls: URLSearchParams[] = []
  const skuCalls: URLSearchParams[] = []
  const receiptPosts: Array<{ query: URLSearchParams; body: Record<string, unknown>; key: string | undefined }> = []
  const adjustPosts: Array<{ query: URLSearchParams; body: Record<string, unknown>; key: string | undefined }> = []
  let denySummary = true
  let failNextReceipt = true

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/inventory/overview')) return route.fulfill({ json: { locations: [], rows: [] } })
    if (path.endsWith('/inventory/movements/skus')) {
      skuCalls.push(url.searchParams)
      return route.fulfill({ json: { data: [{ productId: PRODUCT, productName: 'Canvas Bag', variantSize: 'Std', sku: 'CB-STD' }] } })
    }
    if (path.endsWith('/inventory/movements/summary')) {
      summaryCalls.push(url.searchParams)
      if (denySummary) return route.fulfill({ status: 403, json: { error: 'lokasi di luar cakupan akun' } })
      return route.fulfill({ json: {
        data: [{ productId: PRODUCT, productName: 'Canvas Bag', variantSize: 'Std', sku: 'CB-STD', opening: 0, closing: -3, buckets: { masuk: 5, penjualan: -7, refund: 0, transfer: 0, penyesuaian: 0, hadiah: -1 }, masukGaransi: 5, inByKind: { receipt: 5 }, outByKind: { sale: 8 } }],
        meta: { total: 1, page: 1, limit: 25 },
      } })
    }
    if (path.endsWith(`/inventory/goods-receipts/${RECEIPT_ID}`)) {
      return route.fulfill({ json: {
        id: RECEIPT_ID, locationType: 'outlet', locationId: OUTLET, locationName: 'MV Outlet', source: 'warranty',
        supplier: 'Garansi toko', createdAt: '2026-01-03T05:00:00Z', createdByName: 'MV Admin',
        items: [{ productId: PRODUCT, productName: 'Canvas Bag', variantSize: 'Std', sku: 'CB-STD', qty: 5 }],
      } })
    }
    if (path.endsWith('/transfers/location-stock')) {
      return route.fulfill({ json: { data: [{ productId: PRODUCT, productName: 'Canvas Bag', variantSize: 'Std', sku: 'CB-STD', stock: -3 }] } })
    }
    if (path.endsWith('/inventory/goods-receipt') && req.method() === 'POST') {
      receiptPosts.push({ query: url.searchParams, body: JSON.parse(req.postData() ?? '{}') as Record<string, unknown>, key: req.headers()['idempotency-key'] })
      // the first attempt fails (the answer may be lost): the retry must carry the same key
      if (failNextReceipt) {
        failNextReceipt = false
        return route.fulfill({ status: 503, json: { error: 'layanan sementara tidak tersedia' } })
      }
      return route.fulfill({ json: { ok: true } })
    }
    if (path.endsWith('/inventory/adjust') && req.method() === 'POST') {
      adjustPosts.push({ query: url.searchParams, body: JSON.parse(req.postData() ?? '{}') as Record<string, unknown>, key: req.headers()['idempotency-key'] })
      return route.fulfill({ json: { ok: true } })
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
  await openBackoffice(page)

  await openTab(page, 'warehouses', 'pergerakan')
  // a refused read shows its error, not the empty-state text
  await page.getByRole('alert').filter({ hasText: /lokasi di luar cakupan/ }).waitFor()
  check(await page.getByText('Tidak ada pergerakan stok dalam rentang waktu ini').count() === 0, 'empty state shown next to the error')
  results.push({ step: 'summary-error' })
  denySummary = false
  await page.getByLabel('Cari').fill('canvas')
  const summaryRow = page.getByRole('row', { name: /Canvas Bag/ })
  await summaryRow.waitFor()
  for (const h of ['Masuk', 'Penjualan', 'Refund', 'Transfer', 'Penyesuaian', 'Hadiah']) await page.getByRole('columnheader', { name: h, exact: true }).waitFor()
  await summaryRow.getByText('-7', { exact: true }).waitFor()
  check(summaryCalls.some((q) => q.get('locationType') === 'outlet' && q.get('locationId') === OUTLET && !!q.get('from') && !!q.get('to')), 'summary query')
  results.push({ step: 'ringkasan', calls: summaryCalls.length })

  await summaryRow.click()
  await page.getByText('Canvas Bag · Std (CB-STD)').first().waitFor()
  await page.getByText('Saldo Akhir').first().waitFor()
  await page.getByRole('button', { name: 'Tambah penyesuaian', exact: true }).waitFor()
  // the badges sit in their own rows, next to the chips of the same names
  await page.getByRole('row', { name: /INV-3/ }).getByText('Hadiah', { exact: true }).waitFor()
  await page.getByRole('row', { name: /INV-2/ }).getByText('Minus', { exact: true }).waitFor()
  await page.getByText('Tercatat terlambat', { exact: true }).waitFor()
  // the SKU and the location are in the URL, so the card can be bookmarked
  const cardHash = new URL(page.url()).hash
  check(cardHash.startsWith('#/inventori/stok/kartu-stok?') && cardHash.includes(`sku=${PRODUCT}%7CStd`) && cardHash.includes(`lokasi=outlet%3A${OUTLET}`), `card url ${cardHash}`)
  const first = listCalls.find((q) => !q.get('cursor') && !q.get('giveaway'))
  check(!!first && first.get('productId') === PRODUCT && first.get('variantSize') === 'Std' && first.get('locationId') === OUTLET, 'card query')
  results.push({ step: 'card-opens-on-sku', query: first?.toString() })

  await page.getByRole('button', { name: 'Muat lebih banyak' }).click()
  await page.getByRole('button', { name: 'Dokumen barang masuk', exact: true }).waitFor()
  check(listCalls.some((q) => q.get('cursor') === 'c1'), 'cursor sent')
  await page.getByRole('button', { name: 'Muat lebih banyak' }).waitFor({ state: 'detached' })
  results.push({ step: 'paging', rows: 3 })

  // Pergerakan buckets are signed columns, Garansi is marked on the receipt row
  await page.getByText('Garansi', { exact: true }).waitFor()
  // the Dokumen cell of the receipt row opens the receipt in place
  await page.getByRole('button', { name: 'Dokumen barang masuk', exact: true }).click()
  const heading = page.getByRole('heading', { name: 'Barang Masuk', exact: true })
  await heading.waitFor()
  await page.getByText('Penggantian garansi', { exact: true }).waitFor()
  await page.getByRole('cell', { name: 'Canvas Bag', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Tutup' }).last().click()
  await heading.waitFor({ state: 'detached' })
  results.push({ step: 'document-link' })

  // "Tambah barang masuk" opens the goods-in panel on this SKU and location
  await page.getByRole('button', { name: 'Tambah barang masuk', exact: true }).click()
  await heading.waitFor()
  await page.getByLabel('Qty masuk Canvas Bag Std').fill('3')
  await page.getByLabel(/Penggantian garansi/).check()
  await page.getByRole('button', { name: 'Simpan barang masuk', exact: true }).click()
  // the first attempt is refused: the panel stays open with the message
  await page.getByRole('alert').filter({ hasText: /layanan sementara tidak tersedia/ }).waitFor()
  check(receiptPosts.length === 1 && !!receiptPosts[0].key, 'first receipt attempt carries an Idempotency-Key')
  await page.getByRole('button', { name: 'Simpan barang masuk', exact: true }).click()
  await heading.waitFor({ state: 'detached' })
  const post = receiptPosts[1]
  check(receiptPosts.length === 2 && post.query.get('kind') === 'outlet' && post.query.get('id') === OUTLET, 'receipt post location')
  check(post.body.source === 'warranty' && JSON.stringify(post.body.items).includes(`"productId":"${PRODUCT}"`) && JSON.stringify(post.body.items).includes('"qty":3'), 'receipt post body')
  check(post.key === receiptPosts[0].key, 'the retry reuses the key of the first attempt')
  results.push({ step: 'shortcut-goods-in-retry-same-key' })

  // a new open starts with empty lines and its own key
  await page.getByRole('button', { name: 'Tambah barang masuk', exact: true }).click()
  await heading.waitFor()
  check(await page.getByLabel('Qty masuk Canvas Bag Std').inputValue() === '', 'a reopened panel starts empty')
  await page.getByLabel('Qty masuk Canvas Bag Std').fill('1')
  await page.getByRole('button', { name: 'Simpan barang masuk', exact: true }).click()
  await heading.waitFor({ state: 'detached' })
  check(receiptPosts.length === 3 && !!receiptPosts[2].key && receiptPosts[2].key !== receiptPosts[0].key, 'a new open sends a new key')
  results.push({ step: 'shortcut-goods-in-new-open-new-key' })

  // "Tambah penyesuaian": the panel states the change, and the write carries a key
  await page.getByRole('button', { name: 'Tambah penyesuaian', exact: true }).click()
  await page.getByRole('heading', { name: 'Penyesuaian Stok', exact: true }).waitFor()
  await page.getByLabel('Jumlah Baru').fill('2')
  await page.getByText('Stok sekarang -3 → baru 2 (+5)', { exact: true }).waitFor()
  await page.getByLabel('Alasan').selectOption('found')
  await page.getByRole('button', { name: 'Simpan penyesuaian', exact: true }).click()
  await page.getByRole('heading', { name: 'Penyesuaian Stok', exact: true }).waitFor({ state: 'detached' })
  check(adjustPosts.length === 1 && !!adjustPosts[0].key && adjustPosts[0].body.newQty === 2 && adjustPosts[0].query.get('id') === OUTLET, 'adjust post')
  results.push({ step: 'shortcut-adjust' })

  await page.getByRole('button', { name: 'Hadiah', exact: true }).click()
  await page.getByRole('row', { name: /INV-2/ }).waitFor({ state: 'detached' }) // only the giveaway row is left
  check(listCalls.some((q) => q.get('giveaway') === 'true'), 'giveaway filter sent')
  results.push({ step: 'giveaway-chip' })

  // the SKU picker uses its own cheap endpoint, never the summary
  const summaryBefore = summaryCalls.length
  await page.getByRole('button', { name: 'Hapus pilihan SKU' }).click()
  await page.getByLabel('SKU / barcode / nama').fill('canvas')
  await page.getByRole('button', { name: 'Canvas Bag · Std (CB-STD)' }).click()
  check(skuCalls.some((q) => q.get('q') === 'canvas' && q.get('locationId') === OUTLET), 'sku picker query')
  check(summaryCalls.length === summaryBefore, 'sku picker must not call the summary')
  results.push({ step: 'sku-picker' })

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
