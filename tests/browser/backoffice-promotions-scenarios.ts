// Fase D2b: Promosi + Kode Diskon on server paging, URL filters, the D-79 status Switch (confirm on, undo off from a fresh
// read), the SlideOver editor with an untouched-save round trip, and visible errors. Synthetic API, no real backend.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo, clickTab } from './fixture'

const BASE_ID = '00000000-0000-4000-8d2b-'
const idOf = (n: number, kind = 'a') => `${BASE_ID}${kind}${String(n).padStart(11, '0')}`
const OUTLET = idOf(1, 'e')
const GONE_OUTLET = idOf(9, 'e')
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

const day = (offset: number) => new Date(Date.now() + 7 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10)
const FILLERS = 25

type Row = Record<string, any>
interface Call { method: string; path: string; query: Record<string, string>; body?: any }
interface State {
  promotions: Row[]
  codes: Row[]
  calls: Call[]
  failSave: boolean
  failDelete: boolean
  failBatch: boolean
}

const promo = (n: number, over: Row): Row => ({
  id: idOf(n, 'c'), description: null, type: 'percentage', value: 10, minPurchase: null, applicableProductIds: [], applicableVariantKeys: [],
  applicableVariantSizes: [], outletIds: [], combinable: false, combinableWith: [], activeFromHour: null, activeToHour: null, activeDays: [],
  isActive: true, startDate: null, endDate: null, codeOnly: false, bxgyConfig: null, tieredConfig: null, bundleConfig: null,
  createdAt: '2026-10-01T03:00:00Z', ...over,
})

const makeState = (): State => ({
  promotions: [
    promo(1, { name: 'Raya Aktif' }),
    promo(2, { name: 'Raya Terjadwal', startDate: day(1) }),
    promo(3, { name: 'Raya Berakhir', endDate: day(-1) }),
    promo(4, { name: 'Raya Nonaktif', isActive: false }),
    // every field set to something non-default: an untouched save must send all of it back
    promo(5, {
      name: 'Raya Lengkap', description: 'Semua kolom terisi', type: 'tiered', value: 0, minPurchase: null,
      applicableProductIds: [idOf(1, 'a')], applicableVariantKeys: [`${idOf(1, 'a')}::M`], applicableVariantSizes: ['M', 'L'],
      outletIds: [OUTLET, GONE_OUTLET], combinable: true, combinableWith: [idOf(1, 'c')], activeFromHour: '10:00', activeToHour: '18:00',
      activeDays: [1, 2], codeOnly: true, startDate: day(-3), endDate: day(30),
      tieredConfig: { tiers: [{ minSubtotal: 100000, kind: 'percentage', value: 5 }, { minSubtotal: 300000, kind: 'fixed', value: 40000 }] },
    }),
    ...Array.from({ length: FILLERS }, (_, i) => promo(10 + i, { name: `Filler ${String(i).padStart(2, '0')}` })),
  ],
  codes: [
    {
      id: idOf(1, 'd'), code: 'Raw-Mixed', promotionId: idOf(1, 'c'), type: 'fixed', value: 5000, minPurchase: 100000, usageLimit: null,
      perCustomerLimit: 2, customerId: idOf(1, 'f'), customerName: 'Synthetic Customer', usageCount: 3, isActive: true,
      startDate: null, endDate: null, combinable: true, createdAt: '2026-10-02T03:00:00Z',
    },
    {
      id: idOf(2, 'd'), code: 'HEMAT10', promotionId: null, type: 'percentage', value: 10, minPurchase: null, usageLimit: 50,
      perCustomerLimit: null, customerId: null, customerName: null, usageCount: 0, isActive: false, startDate: null, endDate: null,
      combinable: false, createdAt: '2026-10-03T03:00:00Z',
    },
  ],
  calls: [], failSave: false, failDelete: false, failBatch: false,
})

/** The server's derived status over is_active / start_date / end_date, the WIB business day. */
const statusOf = (r: Row, today: string): string =>
  !r.isActive ? 'nonaktif' : r.endDate && r.endDate < today ? 'berakhir' : r.startDate && r.startDate > today ? 'terjadwal' : 'aktif'

function pageOf(all: Row[], query: Record<string, string>, textOf: (r: Row) => string) {
  const today = day(0)
  const q = (query.q ?? '').toLowerCase()
  const rows = all.filter((r) => (!q || textOf(r).toLowerCase().includes(q)) && (!query.type || r.type === query.type) && (!query.status || statusOf(r, today) === query.status))
  const page = Number(query.page) || 1
  const limit = Number(query.limit) || 50
  const slice = rows.slice((page - 1) * limit, page * limit)
  return { data: slice, meta: { total: slice.length === 0 && page > 1 ? 0 : rows.length, page, limit } }
}

async function mockApi(page: ScenarioPage, state: State) {
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
    if (path === '/settings/app') return json({ data: { paymentMethods: [] } })
    if (path === '/products') return json({ data: [], meta: { total: 0, page: Number(query.page) || 1, limit: Number(query.limit) || 50 } })
    for (const [base, list, textOf] of [
      ['/promotions', state.promotions, (r: Row) => `${r.name} ${r.description ?? ''}`],
      ['/discount-codes', state.codes, (r: Row) => `${r.code} ${r.customerName ?? ''}`],
    ] as const) {
      if (path === base && method === 'GET') return json('page' in query ? pageOf(list, query, textOf) : { data: list })
      if (path === base && method === 'POST') {
        const row = { ...body, id: idOf(500 + list.length, 'c'), createdAt: new Date().toISOString() }
        list.unshift(row)
        return json({ data: row })
      }
      const one = new RegExp(`^${base}/([^/]+)$`).exec(path)
      if (one && method === 'PUT') {
        if (state.failSave) return json({ error: 'Nama sudah dipakai promosi lain' }, 422)
        const row = list.find((r) => r.id === one[1])
        if (!row) return json({ error: 'tidak ditemukan' }, 404)
        Object.assign(row, body)
        return json({ data: row })
      }
      if (one && method === 'DELETE') {
        if (state.failDelete) return json({ error: 'dipakai oleh kode diskon aktif; nonaktifkan saja' }, 409)
        list.splice(list.findIndex((r) => r.id === one[1]), 1)
        return json({ data: { ok: true } })
      }
    }
    if (path === '/discount-codes/batch' && method === 'POST') return state.failBatch ? json({ error: 'Awalan sudah dipakai kode lain' }, 422) : json({ data: [] })
    return json({ data: [], meta: { total: 0, page: 1, limit: 50 } })
  })
}

const hashQuery = (page: ScenarioPage) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] ?? '')))
const lastList = (calls: Call[], path: string) => [...calls].reverse().find((c) => c.method === 'GET' && c.path === path && 'page' in c.query && c.query.limit !== '1' && c.query.limit !== '200')
const puts = (state: State, path: string) => state.calls.filter((c) => c.method === 'PUT' && c.path.startsWith(path))
/** Poll a condition on the synthetic server (a write that lands after the click). */
async function until(page: ScenarioPage, cond: () => boolean, msg: string) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return
    await page.waitForTimeout(50)
  }
  throw new Error(msg)
}
const rowOf = (page: ScenarioPage, name: string) => page.getByRole('row').filter({ hasText: name })

async function captureCsv(page: ScenarioPage, click: () => Promise<void>): Promise<string[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __d2bCsv: Promise<string>[] }
    w.__d2bCsv = []
    URL.createObjectURL = (b: Blob | MediaSource) => { w.__d2bCsv.push((b as Blob).text()); return 'blob:synthetic' }
    HTMLAnchorElement.prototype.click = function () {}
  })
  await click()
  await page.waitForFunction(() => (window as unknown as { __d2bCsv: unknown[] }).__d2bCsv.length > 0)
  const csv = (await page.evaluate(() => Promise.all((window as unknown as { __d2bCsv: Promise<string>[] }).__d2bCsv)))[0]
  return csv.split('\n').filter(Boolean)
}

async function listAndFilters(page: ScenarioPage, state: State, results: object[]) {
  await rowOf(page, 'Raya Aktif').waitFor()
  await page.getByText(`${5 + FILLERS} promosi`, { exact: true }).waitFor()
  const first = lastList(state.calls, '/promotions')!
  check(first.query.page === '1' && first.query.limit === '25' && !('q' in first.query) && !('status' in first.query) && !('type' in first.query), 'default request is page 1 of 25 with no filters')
  check((await page.locator('tbody tr').count()) === 25, 'one server page of 25 rows')
  // badges follow the WIB business day, like the server's filter
  for (const [name, badge] of [['Raya Aktif', 'Aktif'], ['Raya Terjadwal', 'Terjadwal'], ['Raya Berakhir', 'Berakhir'], ['Raya Nonaktif', 'Nonaktif']] as const) {
    await rowOf(page, name).getByText(badge, { exact: true }).waitFor()
  }
  results.push({ step: 'default-page-and-badges' })

  // a status chip and a search are server parameters AND URL state; the page returns to 1
  await page.getByRole('button', { name: 'Terjadwal', exact: true }).click()
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('status') === 'terjadwal')
  await page.getByText('1 promosi', { exact: true }).waitFor()
  check(lastList(state.calls, '/promotions')!.query.status === 'terjadwal', 'status reaches the server')
  await page.getByLabel('Cari promosi').fill('Raya')
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('q') === 'Raya')
  check(lastList(state.calls, '/promotions')!.query.q === 'Raya', 'search reaches the server')
  results.push({ step: 'filters-in-url-and-request', query: await hashQuery(page) })

  // the filters survive a reload, and the export carries the same filters (one matching row)
  await page.reload()
  await page.getByText('1 promosi', { exact: true }).waitFor()
  check((await page.getByLabel('Cari promosi').inputValue()) === 'Raya', 'search text survives a reload')
  check((await page.getByRole('button', { name: 'Terjadwal', exact: true }).getAttribute('aria-pressed')) === 'true', 'status chip survives a reload')
  state.calls.length = 0
  const filtered = await captureCsv(page, async () => {
    await page.getByRole('button', { name: 'Unduh', exact: true }).click()
    await page.getByRole('button', { name: /CSV/ }).click()
  })
  check(filtered.length === 2 && filtered[1].includes('Raya Terjadwal'), `filtered export has the one matching row, got ${filtered.length - 1}`)
  check(state.calls.filter((c) => c.path === '/promotions' && c.query.limit === '200').every((c) => c.query.status === 'terjadwal' && c.query.q === 'Raya'), 'export carries the same filter')
  await page.getByRole('button', { name: /^Atur ulang filter/ }).click()
  await page.getByText(`${5 + FILLERS} promosi`, { exact: true }).waitFor()
  state.calls.length = 0
  const everything = await captureCsv(page, async () => {
    await page.getByRole('button', { name: 'Unduh', exact: true }).click()
    await page.getByRole('button', { name: /CSV/ }).click()
  })
  check(everything.length === 5 + FILLERS + 1, `unfiltered export has every promotion, got ${everything.length - 1}`)
  results.push({ step: 'reload-and-export', rows: [filtered.length - 1, everything.length - 1] })

  // paging is a URL change and a server request
  await page.getByRole('button', { name: /Berikutnya/ }).click()
  await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('hal') === '2')
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 5)
  check(lastList(state.calls, '/promotions')!.query.page === '2', 'page 2 is requested from the server')
  await page.getByRole('button', { name: /Sebelumnya/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 25)
  results.push({ step: 'paging' })
}

async function statusSwitch(page: ScenarioPage, state: State, results: object[]) {
  const confirm = page.getByRole('alertdialog')
  const aktif = state.promotions[0]
  // OFF saves at once, without a question
  state.calls.length = 0
  await rowOf(page, 'Raya Aktif').getByRole('switch', { name: 'Status Raya Aktif', exact: true }).click()
  await page.getByText('Promo Raya Aktif dinonaktifkan', { exact: true }).waitFor()
  check((await confirm.count()) === 0, 'turning off asks nothing')
  const off = puts(state, '/promotions/')
  check(off.length === 1 && off[0].body.isActive === false && off[0].body.name === 'Raya Aktif', 'OFF is one PUT with the status changed')
  // Somebody renames the promotion before "Urungkan": the undo must send the FRESH row, not the stale one
  aktif.name = 'Raya Aktif Baru'
  aktif.value = 25
  await page.getByRole('button', { name: 'Urungkan', exact: true }).click()
  await until(page, () => puts(state, '/promotions/').length === 2, 'the undo PUT never arrived')
  const undone = puts(state, '/promotions/')
  check(undone.length === 2 && undone[1].body.isActive === true, 'undo turns it back on')
  check(undone[1].body.name === 'Raya Aktif Baru' && undone[1].body.value === 25, 'undo sends the fresh row, not the stale copy')
  results.push({ step: 'off-saves-at-once-undo-is-fresh', undo: undone[1].body })

  // ON asks first; Batal writes nothing; Aktifkan writes once
  state.calls.length = 0
  const sw = rowOf(page, 'Raya Nonaktif').getByRole('switch', { name: 'Status Raya Nonaktif', exact: true })
  await sw.click()
  await confirm.getByText('Aktifkan promo Raya Nonaktif?', { exact: true }).waitFor()
  await confirm.getByText('Tablet memakainya setelah sinkron berikutnya.', { exact: true }).waitFor()
  await confirm.getByRole('button', { name: 'Batal', exact: true }).click()
  await confirm.waitFor({ state: 'detached' })
  check(puts(state, '/promotions/').length === 0, 'Batal writes nothing')
  await sw.click()
  await confirm.getByRole('button', { name: 'Aktifkan', exact: true }).click()
  await confirm.waitFor({ state: 'detached' })
  await until(page, () => puts(state, '/promotions/').length === 1, 'the activation PUT never arrived')
  await rowOf(page, 'Raya Nonaktif').getByText('Aktif', { exact: true }).waitFor()
  const on = puts(state, '/promotions/')
  check(on.length === 1 && on[0].body.isActive === true, 'confirming writes once, status on')
  results.push({ step: 'on-asks-first' })
}

async function roundTrip(page: ScenarioPage, state: State, results: object[]) {
  const stored = JSON.parse(JSON.stringify(state.promotions[4])) as Row
  const dialog = page.getByRole('dialog', { name: 'Ubah Promosi' })
  await page.getByRole('button', { name: 'Ubah Raya Lengkap', exact: true }).click()
  await dialog.waitFor()
  check((await hashQuery(page)).ubah === stored.id, '?ubah= holds the promotion id')
  await dialog.getByLabel('Nama Promosi *').waitFor()
  check((await dialog.getByRole('button', { name: 'Semua outlet', exact: true }).getAttribute('aria-pressed')) === 'false', 'a promotion with outlets is not "Semua outlet"')
  await dialog.getByRole('button', { name: 'Outlet tidak dikenal', exact: true }).waitFor()
  check((await dialog.getByText('Perubahan belum disimpan').count()) === 0, 'an untouched edit is not dirty')
  state.calls.length = 0
  await dialog.getByRole('button', { name: 'Simpan', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  check((await page.getByRole('alertdialog').count()) === 0, 'no question after a save')
  const sent = puts(state, `/promotions/${stored.id}`)
  check(sent.length === 1, 'one PUT')
  const { id: _id, createdAt: _created, ...expected } = stored
  const body = sent[0].body
  for (const [key, value] of Object.entries(expected)) {
    check(JSON.stringify(body[key] ?? null) === JSON.stringify(value ?? null) || (Array.isArray(value) && value.length === 0 && (body[key] ?? []).length === 0) || (value === '' && !body[key]), `field ${key} came back unchanged: sent ${JSON.stringify(body[key])} stored ${JSON.stringify(value)}`)
  }
  check(JSON.stringify(body.outletIds) === JSON.stringify([OUTLET, GONE_OUTLET]), 'an outlet missing from the outlet list is kept')
  check(body.minPurchase === null, 'a null minimum stays null')
  results.push({ step: 'untouched-edit-round-trip', body })
}

async function visibleErrors(page: ScenarioPage, state: State, results: object[]) {
  const dialog = page.getByRole('dialog', { name: 'Ubah Promosi' })
  const confirm = page.getByRole('alertdialog')
  // a refused save stays in the panel, with the server's words
  await page.getByRole('button', { name: 'Ubah Raya Terjadwal', exact: true }).click()
  await dialog.waitFor()
  await dialog.getByLabel('Nama Promosi *').fill('Raya Terjadwal Dua')
  await dialog.getByText('Perubahan belum disimpan').waitFor()
  state.failSave = true
  await dialog.getByRole('button', { name: 'Simpan', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: 'Nama sudah dipakai promosi lain' }).waitFor()
  state.failSave = false
  await dialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await confirm.getByRole('button', { name: 'Buang perubahan', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  results.push({ step: 'save-error-visible' })

  // a refused delete keeps the dialog and the reason
  state.failDelete = true
  await page.getByRole('button', { name: 'Hapus Raya Berakhir', exact: true }).click()
  await confirm.getByText('Hapus promosi "Raya Berakhir"?', { exact: true }).waitFor()
  await confirm.getByRole('button', { name: 'Hapus', exact: true }).click()
  await confirm.getByRole('alert').filter({ hasText: 'dipakai oleh kode diskon aktif' }).waitFor()
  await confirm.getByRole('button', { name: 'Batal', exact: true }).click()
  await confirm.waitFor({ state: 'detached' })
  state.failDelete = false
  check(state.promotions.some((p) => p.name === 'Raya Berakhir'), 'the refused delete removed nothing')
  results.push({ step: 'delete-error-visible' })
}

async function codesTab(page: ScenarioPage, state: State, results: object[]) {
  await clickTab(page, 'codes')
  await page.waitForFunction(() => location.hash.startsWith('#/promosi/kode'))
  await rowOf(page, 'Raw-Mixed').waitFor()
  await rowOf(page, 'Raw-Mixed').getByText(/Tertaut: Raya Aktif Baru/).waitFor()
  await rowOf(page, 'Raw-Mixed').getByText('Khusus: Synthetic Customer').waitFor()
  await page.getByText('2 kode diskon', { exact: true }).waitFor()
  results.push({ step: 'codes-list' })

  // an untouched edit keeps the code as stored (mixed case), the holder, the quota and the per-customer cap
  const dialog = page.getByRole('dialog', { name: 'Ubah Kode Diskon' })
  const stored = JSON.parse(JSON.stringify(state.codes[0])) as Row
  await page.getByRole('button', { name: 'Ubah Raw-Mixed', exact: true }).click()
  await dialog.waitFor()
  await dialog.getByText('Synthetic Customer', { exact: true }).waitFor()
  state.calls.length = 0
  await dialog.getByRole('button', { name: 'Simpan', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const body = puts(state, `/discount-codes/${stored.id}`)[0].body
  check(body.code === 'Raw-Mixed', 'the code is sent as stored, not upper-cased')
  check(body.usageLimit === null && body.perCustomerLimit === 2 && body.customerId === stored.customerId, 'quota, cap and holder unchanged')
  check(body.combinable === true && body.promotionId === stored.promotionId && body.minPurchase === 100000, 'combinable, link and minimum unchanged')
  check(!('customerName' in body), 'the holder name is not sent')
  results.push({ step: 'code-round-trip', body })

  // Buat Massal: a refused batch stays in its panel with the reason
  // The batch panel is the kit Modal (a heading, no dialog role): scope by what is on screen with it open.
  const batchTitle = page.getByRole('heading', { name: 'Buat Kode Diskon Massal', exact: true })
  await page.getByRole('button', { name: 'Buat Massal', exact: true }).click()
  await batchTitle.waitFor()
  state.failBatch = true
  await page.getByRole('button', { name: 'Generate', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Awalan sudah dipakai kode lain' }).waitFor()
  check(await batchTitle.isVisible(), 'a refused batch keeps its panel open')
  state.failBatch = false
  await page.getByRole('button', { name: 'Batal', exact: true }).click()
  await batchTitle.waitFor({ state: 'detached' })
  results.push({ step: 'batch-error-visible' })

  // turning a code ON asks first, in the code's words
  const confirm = page.getByRole('alertdialog')
  await rowOf(page, 'HEMAT10').getByRole('switch', { name: 'Status HEMAT10', exact: true }).click()
  await confirm.getByText('Aktifkan kode HEMAT10?', { exact: true }).waitFor()
  await confirm.getByRole('button', { name: 'Batal', exact: true }).click()
  await confirm.waitFor({ state: 'detached' })
  results.push({ step: 'code-on-asks-first' })
}

export async function promotionsFlow(page: ScenarioPage) {
  const state = makeState()
  await mockApi(page, state)
  await openBackoffice(page)
  await navTo(page, 'promotions')
  const results: object[] = []
  await listAndFilters(page, state, results)
  await statusSwitch(page, state, results)
  await roundTrip(page, state, results)
  await visibleErrors(page, state, results)
  await codesTab(page, state, results)
  return results
}
