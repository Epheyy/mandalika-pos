// Fase D5b: Bahan Daftar as a DataTable whose category filter is a SERVER parameter (categoryId), so it covers every matching
// ingredient across pages, not just the rows of one page; plus the delete question (usage block, refusal reason). Synthetic API.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navItem } from './fixture'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const CAT_OIL = '00000000-0000-4000-8f6b-0000000000c1'
const CAT_BOTTLE = '00000000-0000-4000-8f6b-0000000000c2'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const ingId = (n: number) => `00000000-0000-4000-8f6b-${String(n).padStart(12, '0')}`
const OILS = 60
const BOTTLES = 30
const REFUSAL = 'bahan masih punya stok sehingga tidak bisa dihapus'

const settings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: true,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
}

interface MockIngredient { id: string; name: string; unit: string; sku: string; categoryId: string; categoryName: string; isActive: boolean; createdAt: string }
interface Call { method: string; path: string; query: Record<string, string> }

// Minyak 001..060 in the oil category, Botol 061..090 in the bottle category, interleaved by id so a page of the unfiltered list
// holds both kinds (a client-side category filter over one page would then drop rows that exist on other pages).
const makeIngredients = (): MockIngredient[] =>
  Array.from({ length: OILS + BOTTLES }, (_, i) => {
    const oil = i % 3 !== 2
    return {
      id: ingId(i + 1), name: `${oil ? 'Minyak' : 'Botol'} ${String(i + 1).padStart(3, '0')}`, unit: oil ? 'ml' : 'pcs', sku: '',
      categoryId: oil ? CAT_OIL : CAT_BOTTLE, categoryName: oil ? 'Minyak' : 'Botol', isActive: true, createdAt: '2026-01-03T05:00:00Z',
    }
  })

async function mockApi(page: ScenarioPage, state: { all: MockIngredient[]; calls: Call[]; failDelete: boolean }) {
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace('/api/v1', '')
    const query = Object.fromEntries(url.searchParams)
    const method = req.method()
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value })
    if (path.includes('/auth/')) return json({ data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } })
    if (path === '/outlets') return json({ data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] })
    if (path === '/settings/app') return json({ data: settings })
    if (path === '/ingredient-categories') return json({ data: [{ id: CAT_OIL, name: 'Minyak', createdAt: '2026-01-01T00:00:00Z' }, { id: CAT_BOTTLE, name: 'Botol', createdAt: '2026-01-01T00:00:00Z' }] })
    if (path === '/ingredients' && method === 'GET') {
      state.calls.push({ method, path, query })
      const rows = state.all.filter((i) => (!query.categoryId || i.categoryId === query.categoryId) && (!query.q || i.name.toLowerCase().includes(query.q.toLowerCase())))
      const pageNo = Number(query.page) || 1
      const limit = Number(query.limit) || 50
      return json({ data: rows.slice((pageNo - 1) * limit, pageNo * limit), meta: { total: rows.length, page: pageNo, limit } })
    }
    const usage = path.match(/^\/ingredients\/(.+)\/usage$/)
    if (usage) {
      const linked = usage[1] === ingId(1)
      return json({ variants: linked ? [{ productName: 'Parfum Uji', variantSize: '30 ml' }] : [] })
    }
    const one = path.match(/^\/ingredients\/(.+)$/)
    if (one && method === 'DELETE') {
      state.calls.push({ method, path, query })
      if (state.failDelete) return json({ error: REFUSAL }, 409)
      state.all = state.all.filter((i) => i.id !== one[1])
      return json({ data: { ok: true } })
    }
    return json({ data: [], meta: { total: 0, page: 1, limit: 50 } })
  })
}

const hashOf = (page: ScenarioPage) => page.evaluate(() => location.hash)

async function deepLink(page: ScenarioPage, hash: string) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.reload()
}

export const bahanDaftarFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const state = { all: makeIngredients(), calls: [] as Call[], failDelete: true }
  await mockApi(page, state)
  await openBackoffice(page)
  await navItem(page, 'dashboard').waitFor()
  const lastList = () => state.calls.filter((c) => c.method === 'GET' && c.path === '/ingredients').pop()
  const table = page.getByRole('table', { name: 'Daftar bahan' })
  const rowNames = async () => (await table.getByRole('row').allInnerTexts()).filter((t) => /^(Minyak|Botol) \d{3}/.test(t.trim())).map((t) => t.trim().slice(0, 10))

  // (a) the category is a server filter: 60 oils span three pages of 25, and every page carries categoryId
  await deepLink(page, `#/inventori/bahan/daftar?kategori=${CAT_OIL}`)
  await table.getByText('Minyak 001', { exact: true }).waitFor()
  check(lastList()?.query.categoryId === CAT_OIL && lastList()?.query.page === '1', `page 1 carries categoryId: ${JSON.stringify(lastList()?.query)}`)
  check((await page.getByText(`${OILS} catatan`).count()) === 1, `the total is the whole category (${OILS}), not one page`)
  check((await rowNames()).length === 25 && (await rowNames()).every((n) => n.startsWith('Minyak')), `25 oil rows, got ${(await rowNames()).join(',')}`)
  results.push({ step: 'category-is-a-server-filter' })

  // (b) the next pages stay inside the category: page 3 holds the last 10 oils, no bottle
  await page.getByRole('button', { name: /Berikutnya/ }).click()
  await table.getByText('Minyak 038', { exact: false }).waitFor()
  check(lastList()?.query.categoryId === CAT_OIL && lastList()?.query.page === '2', `page 2 carries categoryId: ${JSON.stringify(lastList()?.query)}`)
  await page.getByRole('button', { name: /Berikutnya/ }).click()
  await page.getByText('Hal 3/3').waitFor()
  const lastPage = await rowNames()
  check(lastPage.length === 10 && lastPage.every((n) => n.startsWith('Minyak')), `page 3 holds the last 10 oils, got ${lastPage.join(',')}`)
  results.push({ step: 'later-pages-keep-the-category' })

  // (c) changing the category returns to page 1 and the URL carries it; a reload restores the filter and the request
  await page.getByLabel('Kategori', { exact: true }).selectOption(CAT_BOTTLE)
  await page.getByText(`${BOTTLES} catatan`).waitFor()
  check(!(await hashOf(page)).includes('hal='), `a new category returns to page 1, got ${await hashOf(page)}`)
  check(lastList()?.query.categoryId === CAT_BOTTLE && lastList()?.query.page === '1', `the request switches category: ${JSON.stringify(lastList()?.query)}`)
  await page.reload()
  await page.getByText(`${BOTTLES} catatan`).waitFor()
  check((await page.getByLabel('Kategori', { exact: true }).inputValue()) === CAT_BOTTLE, 'a reload restores the category select')
  check(lastList()?.query.categoryId === CAT_BOTTLE, 'a reload restores the request')
  await page.getByLabel('Kategori', { exact: true }).selectOption('')
  await page.getByText(`${OILS + BOTTLES} catatan`).waitFor()
  check(lastList()?.query.categoryId === undefined, `Semua kategori sends no categoryId: ${JSON.stringify(lastList()?.query)}`)
  results.push({ step: 'category-url-state' })

  // (d) delete: an ingredient used by a recipe is blocked with the variants listed; a free one asks, keeps the refusal, then deletes
  await deepLink(page, '#/inventori/bahan/daftar')
  await table.getByText('Minyak 001', { exact: true }).waitFor()
  const dialog = page.getByRole('alertdialog')
  await page.getByRole('button', { name: 'Hapus Minyak 001', exact: true }).click()
  await dialog.getByText('Minyak 001 masih dipakai').waitFor()
  await dialog.getByText('Parfum Uji').waitFor()
  check((await dialog.getByRole('button', { name: 'Hapus bahan' }).count()) === 0, 'a used ingredient offers no delete')
  await dialog.getByRole('button', { name: 'Tutup' }).click()
  await dialog.waitFor({ state: 'detached' })
  check(!state.calls.some((c) => c.method === 'DELETE'), 'nothing was deleted')
  await page.getByRole('button', { name: 'Hapus Minyak 002', exact: true }).click()
  await dialog.getByText('Hapus Minyak 002?').waitFor()
  await dialog.getByRole('button', { name: 'Hapus bahan' }).click()
  await dialog.getByText(REFUSAL).waitFor()
  check((await dialog.count()) === 1, 'a refused delete keeps the dialog with the reason')
  state.failDelete = false
  await dialog.getByRole('button', { name: 'Hapus bahan' }).click()
  await dialog.waitFor({ state: 'detached' })
  await table.getByText('Minyak 002', { exact: true }).waitFor({ state: 'detached' })
  results.push({ step: 'delete-confirm-usage-and-refusal' })
  return results
}
