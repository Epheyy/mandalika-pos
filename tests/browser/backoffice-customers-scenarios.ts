// Fase D5b: the Pelanggan list as a DataTable over the server paging contract (OFFSET page/limit + q/sort), its filters and
// page as URL state that survive a reload, and the edit slide-over with its single leave question. Synthetic API.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navItem } from './fixture'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const customerId = (n: number) => `00000000-0000-4000-8f6b-${String(n).padStart(12, '0')}`
const TOTAL = 120
const REFUSAL = 'pelanggan masih punya pesanan terbuka sehingga tidak bisa dihapus'

const settings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: false,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
}

interface MockCustomer {
  id: string; name: string; phone: string; email: string | null; points: number; totalSpent: number; visitCount: number
  tags: []; segment: null; createdAt: string
}
interface Call { method: string; path: string; query: Record<string, string>; body?: unknown }
interface State { customers: MockCustomer[]; calls: Call[]; failNextSave: boolean; failDelete: boolean }

const makeCustomers = (): MockCustomer[] =>
  Array.from({ length: TOTAL }, (_, i) => ({
    id: customerId(i + 1), name: `Pelanggan ${i + 1}`, phone: `0812000${String(i + 1).padStart(4, '0')}`, email: null, points: 10,
    totalSpent: 100000, visitCount: 2, tags: [], segment: null, createdAt: '2026-01-03T05:00:00Z',
  }))

async function mockApi(page: ScenarioPage, state: State) {
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace('/api/v1', '')
    const query = Object.fromEntries(url.searchParams)
    const method = req.method()
    const body = method === 'GET' || method === 'DELETE' ? undefined : JSON.parse(req.postData() ?? '{}')
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value })
    if (path.includes('/auth/')) return json({ data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } })
    if (path === '/outlets') return json({ data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] })
    if (path === '/settings/app') return json({ data: settings })
    if (path === '/customers' && method === 'GET') {
      state.calls.push({ method, path, query })
      const q = (query.q ?? '').toLowerCase()
      const rows = state.customers.filter((c) => !q || c.name.toLowerCase().includes(q))
      const pageNo = Number(query.page) || 1
      const limit = Number(query.limit) || 50
      const slice = rows.slice((pageNo - 1) * limit, pageNo * limit)
      return json({ data: slice, meta: { total: slice.length === 0 && pageNo > 1 ? 0 : rows.length, page: pageNo, limit } })
    }
    const detail = path.match(/^\/customers\/(0{8}-0000-4000-8f6b-\d{12})$/)
    if (detail) {
      const customer = state.customers.find((c) => c.id === detail[1])
      if (!customer) return json({ error: 'pelanggan tidak ditemukan' }, 404)
      if (method === 'GET') return json({ data: customer })
      state.calls.push({ method, path, query, body })
      if (method === 'PUT') {
        if (state.failNextSave) { state.failNextSave = false; return json({ error: 'telepon sudah dipakai' }, 409) }
        Object.assign(customer, body as object)
        return json({ data: customer })
      }
      if (method === 'DELETE') {
        if (state.failDelete) return json({ error: REFUSAL }, 409)
        state.customers = state.customers.filter((c) => c.id !== customer.id)
        return json({ data: { ok: true } })
      }
    }
    return json({ data: [], meta: { total: 0, page: 1, limit: 50 } })
  })
}

const hashOf = (page: ScenarioPage) => page.evaluate(() => location.hash)
const searchBox = (page: ScenarioPage) => page.getByLabel('Cari pelanggan')

async function deepLink(page: ScenarioPage, hash: string) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.reload()
}

const putCalls = (state: State) => state.calls.filter((c) => c.method === 'PUT')

export const customersListFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const state: State = { customers: makeCustomers(), calls: [], failNextSave: false, failDelete: true }
  await mockApi(page, state)
  await openBackoffice(page)
  await navItem(page, 'dashboard').waitFor()
  const lastList = () => state.calls.filter((c) => c.method === 'GET' && c.path === '/customers').pop()

  // (a) a real table: caption, column headers, one row per customer; page 3 of 25 rows is a server request
  await deepLink(page, '#/pelanggan/daftar?hal=3')
  await page.getByText('Pelanggan 51', { exact: true }).waitFor()
  check((await page.getByRole('table', { name: 'Daftar pelanggan' }).count()) === 1, 'the list is a captioned table')
  check((await page.getByRole('columnheader', { name: 'Total Belanja' }).count()) === 1, 'the Total Belanja column header')
  check((await page.getByRole('row').count()) === 26, 'header row plus 25 customer rows')
  check(lastList()?.query.page === '3' && lastList()?.query.limit === '25', `OFFSET paging: ${JSON.stringify(lastList()?.query)}`)
  results.push({ step: 'table-and-server-page' })

  // (b) search and page size are URL state: a search resets the page, and both survive a reload
  await searchBox(page).fill('pelanggan 1')
  await page.getByText('Pelanggan 10', { exact: true }).waitFor()
  check(!(await hashOf(page)).includes('hal='), `a search returns to page 1, got ${await hashOf(page)}`)
  check(lastList()?.query.q === 'pelanggan 1' && lastList()?.query.page === '1', `the request carries q: ${JSON.stringify(lastList()?.query)}`)
  await page.getByLabel('Baris:').selectOption('50')
  await page.waitForFunction(() => location.hash.includes('per=50'))
  const filtered = await hashOf(page)
  await page.reload()
  await page.getByText('Pelanggan 10', { exact: true }).waitFor()
  check((await hashOf(page)) === filtered, 'the URL is unchanged by a reload')
  check((await searchBox(page).inputValue()) === 'pelanggan 1', 'a reload restores the search box')
  check(lastList()?.query.limit === '50' && lastList()?.query.q === 'pelanggan 1', `a reload restores the request: ${JSON.stringify(lastList()?.query)}`)
  results.push({ step: 'filters-survive-reload' })

  // (c) the edit panel is a slide-over with its heading; untouched it closes without a question
  await deepLink(page, '#/pelanggan/daftar')
  await page.getByText('Pelanggan 3', { exact: true }).waitFor()
  const panel = page.getByRole('dialog', { name: 'Edit Pelanggan' })
  const question = page.getByRole('alertdialog')
  const nameInput = panel.getByLabel('Nama *', { exact: true })
  await page.getByRole('button', { name: 'Ubah Pelanggan 3', exact: true }).click()
  await panel.waitFor()
  check((await nameInput.inputValue()) === 'Pelanggan 3', 'the panel opens with the customer')
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  check((await question.count()) === 0, 'an untouched panel closes without asking')
  results.push({ step: 'slideover-untouched-closes' })

  // (d) unsaved work: one question for Escape, the x, Batal and browser Back; Lanjut edit keeps the form, nothing is sent
  await page.getByRole('button', { name: 'Ubah Pelanggan 3', exact: true }).click()
  await panel.waitFor()
  await nameInput.fill('Nama baru')
  await panel.getByText('Perubahan belum disimpan').waitFor()
  const listHash = await hashOf(page)
  const exits: Array<[string, () => Promise<unknown>]> = [
    ['Escape', () => page.keyboard.press('Escape')],
    ['x', () => panel.getByRole('button', { name: 'Tutup' }).click()],
    ['Batal', () => panel.getByRole('button', { name: 'Batal' }).click()],
    ['Back', () => page.evaluate(() => history.back())],
  ]
  for (const [how, act] of exits) {
    await act()
    await question.waitFor()
    check((await question.count()) === 1, `${how} asks exactly one question`)
    await question.getByRole('button', { name: 'Lanjut edit' }).click()
    await question.waitFor({ state: 'detached' })
    check((await nameInput.inputValue()) === 'Nama baru', `${how}: Lanjut edit keeps the edit`)
    check((await hashOf(page)) === listHash, `${how}: Lanjut edit keeps the exact hash, got ${await hashOf(page)}`)
  }
  await page.keyboard.press('Escape')
  await question.getByRole('button', { name: 'Buang perubahan' }).click()
  await panel.waitFor({ state: 'detached' })
  check(putCalls(state).length === 0, 'discarding saves nothing')
  // Back while dirty, answered "Buang perubahan": the move goes ahead AND the panel goes down (nothing saved)
  await page.getByRole('button', { name: 'Ubah Pelanggan 3', exact: true }).click()
  await panel.waitFor()
  await nameInput.fill('Nama lain')
  await page.evaluate(() => history.back())
  await question.getByRole('button', { name: 'Buang perubahan' }).click()
  await panel.waitFor({ state: 'detached' })
  await page.waitForFunction((h) => location.hash !== h, listHash)
  check(putCalls(state).length === 0, 'Back + discard saves nothing')
  // An untouched panel closes with any route move (it is not part of the URL): no question, nothing left over the list
  await deepLink(page, '#/pelanggan/daftar')
  await page.getByText('Pelanggan 3', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Ubah Pelanggan 3', exact: true }).click()
  await panel.waitFor()
  await page.evaluate(() => history.back())
  await panel.waitFor({ state: 'detached' })
  check((await question.count()) === 0, 'Back on an untouched panel asks nothing')
  await deepLink(page, '#/pelanggan/daftar')
  await page.getByText('Pelanggan 3', { exact: true }).waitFor()
  results.push({ step: 'slideover-one-leave-question' })

  // (e) a refused save stays visible in the panel; the retry saves and closes without a question
  await page.getByRole('button', { name: 'Ubah Pelanggan 3', exact: true }).click()
  await panel.waitFor()
  await nameInput.fill('Sari Dewi')
  state.failNextSave = true
  await panel.getByRole('button', { name: 'Simpan' }).click()
  await panel.getByRole('alert').filter({ hasText: 'telepon sudah dipakai' }).waitFor()
  check((await panel.count()) === 1, 'a refused save keeps the panel open')
  await panel.getByRole('button', { name: 'Simpan' }).click()
  await panel.waitFor({ state: 'detached' })
  check((await question.count()) === 0, 'a saved panel closes without asking')
  check(putCalls(state).length === 2 && (putCalls(state)[1].body as { name: string }).name === 'Sari Dewi', `the retry sends the edit: ${JSON.stringify(putCalls(state))}`)
  await page.getByText('Sari Dewi', { exact: true }).waitFor()
  results.push({ step: 'save-refused-then-saved' })

  // (f) delete asks first, keeps the server's reason on a refusal, and removes the row once allowed
  await page.getByRole('button', { name: 'Hapus Pelanggan 4', exact: true }).click()
  await question.getByText('Hapus Pelanggan 4?').waitFor()
  await question.getByRole('button', { name: 'Batal' }).click()
  await question.waitFor({ state: 'detached' })
  check(!state.calls.some((c) => c.method === 'DELETE'), 'Batal deletes nothing')
  await page.getByRole('button', { name: 'Hapus Pelanggan 4', exact: true }).click()
  await question.getByRole('button', { name: 'Hapus pelanggan' }).click()
  await question.getByText(REFUSAL).waitFor()
  check((await question.count()) === 1, 'a refused delete keeps the dialog with the reason')
  state.failDelete = false
  await question.getByRole('button', { name: 'Hapus pelanggan' }).click()
  await question.waitFor({ state: 'detached' })
  await page.getByText('Pelanggan 4', { exact: true }).waitFor({ state: 'detached' })
  results.push({ step: 'delete-confirm-and-refusal' })
  return results
}
