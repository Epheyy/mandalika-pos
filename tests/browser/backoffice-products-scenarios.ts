// Fase D2a: the Produk list on server filters and URL state, the editor slide-over and its leave guard, the recipe
// layer, delete with the server's refusal, and the export of every matching row. Synthetic API, no real backend.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo } from './fixture'

const BASE_ID = '00000000-0000-4000-8f6c-'
const idOf = (n: number, kind = 'a') => `${BASE_ID}${kind}${String(n).padStart(11, '0')}`
const OUTLET = idOf(1, 'e')
const CAT_A = idOf(1, 'c')
const CAT_B = idOf(2, 'c')
const TOTAL = 230
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const REFUSAL = 'produk punya riwayat stok (penerimaan, penyesuaian atau transfer) sehingga tidak bisa dihapus; nonaktifkan produk saja (matikan Produk Aktif)'

const EMPTY_SUMMARY = {
  from: null, to: null, outletId: null, totalSales: 0, totalOrders: 0, grossSales: 0, grossOrders: 0, totalRefunds: 0, refundedOrders: 0,
  netSales: 0, avgOrderValue: 0, byPaymentMethod: {}, grossByPaymentMethod: {}, refundsByPaymentMethod: {}, topProducts: [], dailySales: [],
}

interface MockProduct {
  id: string; name: string; brand: string; categoryId: string; isActive: boolean; isFeatured: boolean; sellable: boolean
  createdAt: string; variants: Array<{ id: string; size: string; price: number; stock: number; sku: string; barcode: string }>
}

// Newest first. Names count down with the index, so "Nama A-Z" reverses the default order. Product 0 is a single-unit product.
const makeProducts = (): MockProduct[] =>
  Array.from({ length: TOTAL }, (_, i) => ({
    id: idOf(i), name: `Parfum ${String(TOTAL - 1 - i).padStart(3, '0')}`, brand: 'Mandalika',
    categoryId: i % 2 ? CAT_B : CAT_A, isActive: i % 5 !== 0, isFeatured: false, sellable: true,
    createdAt: '2026-01-03T05:00:00Z',
    variants: [{ id: idOf(i, 'b'), size: i === 0 ? 'Satuan' : '30 ml', price: 150000, stock: i % 7 === 0 ? 0 : i % 7 === 1 ? 2 : 20, sku: `SKU-${i}`, barcode: `BC-${i}` }],
  }))

interface Call { method: string; path: string; query: Record<string, string>; body?: unknown }

/** The server's product list: contains-match q, category, active, stock, sort, then a page. Past the end it answers total 0. */
function productPage(all: MockProduct[], query: Record<string, string>) {
  const q = (query.q ?? '').toLowerCase()
  let rows = all.filter((p) =>
    (!q || p.name.toLowerCase().includes(q) || p.variants.some((v) => v.sku.toLowerCase().includes(q))) &&
    (!query.categoryId || p.categoryId === query.categoryId) &&
    (query.active === undefined || p.isActive === (query.active === 'true')) &&
    (!query.stock || p.variants.some((v) => (query.stock === 'out' ? v.stock <= 0 : v.stock >= 1 && v.stock <= 2))))
  if (query.sort === 'nama') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name))
  const page = Number(query.page) || 1
  const limit = Number(query.limit) || 50
  const slice = rows.slice((page - 1) * limit, page * limit)
  return { data: slice, meta: { total: slice.length === 0 && page > 1 ? 0 : rows.length, page, limit } }
}

async function mockApi(page: ScenarioPage, state: { products: MockProduct[]; calls: Call[]; deleteRefusal: boolean }) {
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace('/api/v1', '')
    const query = Object.fromEntries(url.searchParams)
    const method = req.method()
    const body = method === 'GET' || method === 'DELETE' ? undefined : JSON.parse(req.postData() ?? '{}')
    state.calls.push({ method, path, query, body })
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data })
    if (path.startsWith('/auth/')) return json({ data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } })
    if (path === '/outlets') return json({ data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] })
    if (path === '/settings/app') return json({ data: { recipesEnabled: true, paymentMethods: [] } })
    if (path === '/categories') return json({ data: [{ id: CAT_A, name: 'Floral' }, { id: CAT_B, name: 'Woody' }] })
    if (path === '/bundles') return json({ data: [] })
    if (path === '/reports/summary') return json({ data: EMPTY_SUMMARY })
    if (path === '/products' && method === 'GET') return json(productPage(state.products, query))
    const detail = /^\/products\/([^/]+)$/.exec(path)
    if (detail) {
      const product = state.products.find((p) => p.id === detail[1])
      if (!product) return json({ error: 'produk tidak ditemukan' }, 404)
      if (method === 'DELETE') return state.deleteRefusal ? json({ error: REFUSAL }, 409) : json({ data: { ok: true } })
      if (method === 'PUT') { Object.assign(product, body as object); return json({ data: product }) }
      return json({ data: product })
    }
    if (/^\/products\/[^/]+\/outlet-config$/.test(path)) {
      return method === 'PUT' ? json({ data: { ok: true } }) : json({ data: [{ outletId: OUTLET, outletName: 'MV Outlet', variantSize: 'x', price: null, available: true }] })
    }
    if (/\/recipe-variant-ids$/.test(path)) return json({ variantIds: [] })
    if (/\/recipe$/.test(path)) return json({ error: 'resep belum ada' }, 404)
    return json({ data: [], meta: { total: 0, page: 1, limit: 50 } })
  })
}

const hashQuery = (page: ScenarioPage) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] ?? '')))
const hashOf = (page: ScenarioPage) => page.evaluate(() => location.hash)
const rowCount = (page: ScenarioPage) => page.locator('tbody tr').count()
const lastList = (calls: Call[]) => [...calls].reverse().find((c) => c.method === 'GET' && c.path === '/products' && c.query.limit !== '1' && c.query.limit !== '200')
const countHeader = (page: ScenarioPage) => page.getByText(/^\d+ produk$/)

async function captureCsv(page: ScenarioPage, click: () => Promise<void>): Promise<string[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __d2aCsv: Promise<string>[] }
    w.__d2aCsv = []
    URL.createObjectURL = (b: Blob | MediaSource) => { w.__d2aCsv.push((b as Blob).text()); return 'blob:synthetic' }
    HTMLAnchorElement.prototype.click = function () {}
  })
  await click()
  await page.waitForFunction(() => (window as unknown as { __d2aCsv: unknown[] }).__d2aCsv.length > 0)
  const csv = (await page.evaluate(() => Promise.all((window as unknown as { __d2aCsv: Promise<string>[] }).__d2aCsv)))[0]
  return csv.split('\n').filter(Boolean)
}

async function listFiltersFlow(page: ScenarioPage, state: { calls: Call[] }, results: object[]) {
  // (a) the default state: one server page of 25, the total in the header, no filter parameters
  await page.locator('tbody tr').first().waitFor()
  await countHeader(page).waitFor()
  check((await countHeader(page).textContent()) === `${TOTAL} produk`, 'header count is the server total')
  check((await rowCount(page)) === 25, `25 rows on the first page, got ${await rowCount(page)}`)
  const first = lastList(state.calls)!
  check(first.query.page === '1' && first.query.limit === '25' && !('q' in first.query) && !('active' in first.query), 'default request is page 1 of 25 with no filters')
  // the Satuan sentinel: a single-unit product reads "Stok: n", never "Satuan"
  const newest = page.locator('tbody tr').first()
  check(!(await newest.innerText()).includes('Satuan'), 'the Satuan sentinel is not shown')
  check((await newest.innerText()).includes('Stok: Habis'), 'single-unit stock badge reads Stok: Habis')
  results.push({ step: 'default-server-page' })

  // (b) search and a status chip go to the server and into the URL; the page returns to 1
  await page.getByLabel('Cari produk').fill('Parfum 22')
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('q') === 'Parfum 22')
  await page.getByRole('button', { name: 'Aktif', exact: true }).click()
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('status') === 'aktif')
  await page.getByText('8 produk', { exact: true }).waitFor()
  const filtered = lastList(state.calls)!
  check(filtered.query.q === 'Parfum 22' && filtered.query.active === 'true' && filtered.query.page === '1', 'filters reach the server')
  results.push({ step: 'filters-in-url-and-request', query: await hashQuery(page) })

  // (c) a reload keeps them
  await page.reload()
  await page.getByText('8 produk', { exact: true }).waitFor()
  check((await page.getByLabel('Cari produk').inputValue()) === 'Parfum 22', 'search text survives a reload')
  check((await page.getByRole('button', { name: 'Aktif', exact: true }).getAttribute('aria-pressed')) === 'true', 'status chip survives a reload')
  await page.getByRole('button', { name: /^Atur ulang filter/ }).click()
  await page.waitForFunction(() => location.hash === '#/produk' || location.hash === '#/produk/daftar')
  await page.getByText(`${TOTAL} produk`, { exact: true }).waitFor()
  results.push({ step: 'reload-and-reset' })

  // (d) paging: the next page is a URL change; a pasted page past the end steps back to the last real page
  await page.getByRole('button', { name: /Berikutnya/ }).click()
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('hal') === '2')
  check(lastList(state.calls)!.query.page === '2', 'page 2 is requested from the server')
  await page.evaluate(() => { location.hash = '#/produk?hal=99' })
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('hal') === '10')
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 5)
  results.push({ step: 'page-clamp', hash: await hashOf(page) })

  // (e) the stock chip maps to the stock parameter
  await page.getByRole('button', { name: 'Habis', exact: true }).click()
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('stok') === 'out')
  check(lastList(state.calls)!.query.stock === 'out' && lastList(state.calls)!.query.page === '1', 'stock=out reaches the server on page 1')
  await page.getByRole('button', { name: /^Atur ulang filter/ }).click()
  await page.getByText(`${TOTAL} produk`, { exact: true }).waitFor()
  results.push({ step: 'stock-chip' })
}

async function exportFlow(page: ScenarioPage, state: { calls: Call[] }, results: object[]) {
  const unduh = async (format: RegExp) => {
    await page.getByRole('button', { name: 'Unduh', exact: true }).click()
    await page.getByRole('button', { name: format }).click()
  }
  // every product, across two server pages of 200
  state.calls.length = 0
  const all = await captureCsv(page, () => unduh(/CSV/))
  check(all.length === TOTAL + 1, `unfiltered export has every product, got ${all.length - 1}`)
  const pages = state.calls.filter((c) => c.path === '/products' && c.query.limit === '200').map((c) => c.query.page)
  check(pages.join() === '1,2', `export walks two pages, got ${pages.join()}`)
  // only what matches the filters
  await page.getByRole('button', { name: 'Aktif', exact: true }).click()
  await page.getByText('184 produk', { exact: true }).waitFor()
  state.calls.length = 0
  const active = await captureCsv(page, () => unduh(/CSV/))
  check(active.length === 185, `filtered export has 184 rows, got ${active.length - 1}`)
  check(state.calls.filter((c) => c.path === '/products' && c.query.limit === '200').every((c) => c.query.active === 'true'), 'export carries the same filter')
  await page.getByRole('button', { name: /^Atur ulang filter/ }).click()
  await page.getByText(`${TOTAL} produk`, { exact: true }).waitFor()
  results.push({ step: 'export-all-matching', rows: [all.length - 1, active.length - 1] })
}

async function editorFlow(page: ScenarioPage, state: { calls: Call[]; products: MockProduct[] }, results: object[]) {
  const target = state.products[3]
  const dialog = page.getByRole('dialog', { name: 'Ubah Produk' })
  const confirm = page.getByRole('alertdialog')
  const nameInput = dialog.getByLabel('Nama Produk *')

  // (a) the overlay is URL state: it opens from the row, survives a reload and loads the BASE product by id
  await page.getByRole('button', { name: `Ubah ${target.name}`, exact: true }).click()
  await dialog.waitFor()
  check((await hashQuery(page)).ubah === target.id, '?ubah= holds the product id')
  await page.reload()
  await dialog.waitFor()
  check((await nameInput.inputValue()) === target.name, 'a reload reopens the same product')
  check(state.calls.some((c) => c.method === 'GET' && c.path === `/products/${target.id}`), 'the product is loaded by id')
  check((await dialog.getByLabel('Ukuran varian').inputValue()) === '30 ml', 'size shown')
  results.push({ step: 'overlay-reload' })

  // (b) one question for Escape on unsaved work; "Lanjut edit" keeps the edit, "Buang perubahan" closes and saves nothing
  await nameInput.fill('Nama baru')
  await dialog.getByText('Perubahan belum disimpan').waitFor()
  await page.keyboard.press('Escape')
  await confirm.waitFor()
  check((await confirm.count()) === 1, 'exactly one question')
  await confirm.getByRole('button', { name: 'Lanjut edit' }).click()
  await confirm.waitFor({ state: 'detached' })
  check((await nameInput.inputValue()) === 'Nama baru', 'the edit survives "Lanjut edit"')
  await page.keyboard.press('Escape')
  await confirm.getByRole('button', { name: 'Buang perubahan' }).click()
  await dialog.waitFor({ state: 'detached' })
  check(!('ubah' in (await hashQuery(page))), 'the overlay left the URL')
  check(!state.calls.some((c) => c.method === 'PUT'), 'nothing was saved')
  results.push({ step: 'escape-guard' })

  // (c) browser Back on unsaved work asks too (the editor was opened by a click, so Back is "close")
  await page.getByRole('button', { name: `Ubah ${target.name}`, exact: true }).click()
  await dialog.waitFor()
  await nameInput.fill('Nama lagi')
  await page.goBack()
  await confirm.waitFor()
  check((await hashQuery(page)).ubah === target.id, 'the URL is put back while the question is open')
  await confirm.getByRole('button', { name: 'Buang perubahan' }).click()
  await dialog.waitFor({ state: 'detached' })
  results.push({ step: 'back-guard' })

  // (d) a save closes without asking, and the list shows the saved name
  await page.getByRole('button', { name: `Ubah ${target.name}`, exact: true }).click()
  await dialog.waitFor()
  await nameInput.fill('Parfum Tersimpan')
  await dialog.getByRole('button', { name: 'Simpan', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  check((await confirm.count()) === 0, 'no question after a save')
  const put = state.calls.find((c) => c.method === 'PUT' && c.path === `/products/${target.id}`)
  check(!!put && (put.body as { name: string }).name === 'Parfum Tersimpan', 'the PUT carries the new name')
  await page.getByText('Parfum Tersimpan', { exact: true }).waitFor()
  results.push({ step: 'save-closes-silently' })
}

async function formErrorsFlow(page: ScenarioPage, results: object[]) {
  const dialog = page.getByRole('dialog', { name: 'Tambah Produk' })
  await page.getByRole('button', { name: 'Tambah', exact: true }).first().click()
  await dialog.waitFor()
  check(['1', 'true'].includes((await hashQuery(page)).baru), '?baru= opens the new-product form')
  await dialog.getByRole('button', { name: 'Tambah', exact: true }).last().click()
  await dialog.getByText('Periksa isian berikut:').waitFor()
  await dialog.getByText('Nama produk wajib diisi').waitFor()
  await dialog.getByRole('button', { name: 'Kategori', exact: true }).click()
  check(await page.evaluate(() => document.activeElement?.id === 'product-category'), 'a summary item focuses its field')
  await dialog.getByLabel('Nama Produk *').fill('Produk Baru')
  await dialog.getByText('Nama produk wajib diisi').waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  const confirm = page.getByRole('alertdialog')
  await confirm.getByRole('button', { name: 'Buang perubahan' }).click()
  await dialog.waitFor({ state: 'detached' })
  results.push({ step: 'field-errors' })
}

async function recipeLayerFlow(page: ScenarioPage, state: { products: MockProduct[] }, results: object[]) {
  const target = state.products[4]
  const editor = page.getByRole('dialog', { name: 'Ubah Produk' })
  const recipe = page.getByRole('dialog', { name: 'Resep' })
  await page.getByRole('button', { name: `Ubah ${target.name}`, exact: true }).click()
  await editor.waitFor()
  await editor.getByRole('button', { name: 'Resep 30 ml' }).waitFor()
  await editor.getByRole('button', { name: 'Resep 30 ml' }).click()
  await recipe.waitFor()
  await page.keyboard.press('Escape')
  await recipe.waitFor({ state: 'detached' })
  check((await editor.count()) === 1, 'Escape closed only the recipe layer')
  await page.keyboard.press('Escape')
  await editor.waitFor({ state: 'detached' })
  check((await page.getByRole('alertdialog').count()) === 0, 'an untouched editor closes without a question')
  results.push({ step: 'escape-top-layer-only' })
}

async function deleteFlow(page: ScenarioPage, state: { products: MockProduct[]; deleteRefusal: boolean }, results: object[]) {
  const target = state.products[5]
  state.deleteRefusal = true
  await page.getByRole('button', { name: `Hapus ${target.name}`, exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByText(`Hapus produk "${target.name}"?`).waitFor()
  await dialog.getByRole('button', { name: 'Hapus', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: 'nonaktifkan produk saja' }).waitFor()
  check((await dialog.count()) === 1, 'the dialog stays open with the reason')
  await dialog.getByRole('button', { name: 'Batal' }).click()
  await dialog.waitFor({ state: 'detached' })
  results.push({ step: 'delete-409-reason' })
}

export const productsListFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const state = { products: makeProducts(), calls: [] as Call[], deleteRefusal: false }
  await mockApi(page, state)
  await openBackoffice(page)
  await navTo(page, 'products')
  await listFiltersFlow(page, state, results)
  await exportFlow(page, state, results)
  await editorFlow(page, state, results)
  await formErrorsFlow(page, results)
  await recipeLayerFlow(page, state, results)
  await deleteFlow(page, state, results)
  return results
}
