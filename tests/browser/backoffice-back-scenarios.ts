// Fase D4: browser Back/Forward across list -> detail -> list on Pelanggan. The list's filters and page live in the
// URL, the customer page is a path, and Back (or Kembali) returns to the list exactly as it was (synthetic API).
import type { ScenarioPage } from './fixture'
import { openBackoffice, navItem } from './fixture'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const customerId = (n: number) => `00000000-0000-4000-8f6b-${String(n).padStart(12, '0')}`
const PAGE_SIZE = 25
const TOTAL = 120

const settings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: false,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
}
const customer = (n: number) => ({
  id: customerId(n), name: `Pelanggan ${n}`, phone: `0812000${String(n).padStart(4, '0')}`, email: null, points: 10, totalSpent: 100000,
  visitCount: 2, tags: [], segment: null, createdAt: '2026-01-03T05:00:00Z',
})

interface ListRequest { page: string | null; limit: string | null; q: string | null; sort: string | null }

async function mockApi(page: ScenarioPage, requests: ListRequest[]) {
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/settings/app')) return route.fulfill({ json: { data: settings } })
    if (path.endsWith('/customers') && route.request().method() === 'GET') {
      const p = Number(url.searchParams.get('page') ?? '1')
      const limit = Number(url.searchParams.get('limit') ?? String(PAGE_SIZE))
      requests.push({ page: url.searchParams.get('page'), limit: url.searchParams.get('limit'), q: url.searchParams.get('q'), sort: url.searchParams.get('sort') })
      const rows = Array.from({ length: limit }, (_, i) => customer((p - 1) * limit + i + 1))
      return route.fulfill({ json: { data: rows, meta: { total: TOTAL, page: p, limit } } })
    }
    const detail = path.match(/\/customers\/(0{8}-0000-4000-8f6b-\d{12})$/)
    if (detail) {
      const n = Number(detail[1].slice(-12))
      return route.fulfill({ json: { data: customer(n) } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
}

const hashOf = (page: ScenarioPage) => page.evaluate(() => location.hash)
const idxOf = (page: ScenarioPage) => page.evaluate(() => (history.state as { idx?: number } | null)?.idx ?? -1)
const searchBox = (page: ScenarioPage) => page.getByLabel('Cari pelanggan')

async function deepLink(page: ScenarioPage, hash: string) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.reload()
}

export const routeBackFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const requests: ListRequest[] = []
  await mockApi(page, requests)
  await openBackoffice(page)
  await navItem(page, 'dashboard').waitFor()

  // (a) the filters and page are in the URL and in the request: a pasted link restores them
  await deepLink(page, '#/pelanggan/daftar?q=sari&urut=terbaru&hal=2')
  await page.getByText('Pelanggan 26', { exact: true }).waitFor()
  check((await searchBox(page).inputValue()) === 'sari', 'the search box shows q from the URL')
  check((await page.getByRole('button', { name: 'Terbaru' }).getAttribute('aria-pressed')) === 'true', 'Terbaru is pressed')
  const last = () => requests[requests.length - 1]
  check(last().page === '2' && last().q === 'sari' && last().sort === 'terbaru', `list request carries page, q and sort: ${JSON.stringify(last())}`)
  results.push({ step: 'deep-link-filters' })

  // (b) open a customer: a path, a new history entry
  const listHash = await hashOf(page)
  const listIdx = await idxOf(page)
  await page.getByText('Pelanggan 26', { exact: true }).click()
  await page.getByRole('button', { name: 'Kembali ke Pelanggan' }).waitFor()
  check((await hashOf(page)) === `#/pelanggan/daftar/${customerId(26)}`, `the customer is a path, got ${await hashOf(page)}`)
  check((await idxOf(page)) === listIdx + 1, 'opening a customer is a push')
  results.push({ step: 'open-detail' })

  // (c) Back lands on the list with the same filters, page and request; Forward returns to the customer
  await page.goBack()
  await page.getByText('Pelanggan 26', { exact: true }).waitFor()
  check((await hashOf(page)) === listHash, `Back restores the list URL, got ${await hashOf(page)}`)
  check((await searchBox(page).inputValue()) === 'sari', 'Back keeps the search')
  check((await page.getByRole('button', { name: 'Terbaru' }).getAttribute('aria-pressed')) === 'true', 'Back keeps the sort')
  check(last().page === '2' && last().q === 'sari', `Back refetches the same page: ${JSON.stringify(last())}`)
  await page.goForward()
  await page.getByRole('button', { name: 'Kembali ke Pelanggan' }).waitFor()
  check((await hashOf(page)) === `#/pelanggan/daftar/${customerId(26)}`, 'Forward returns to the customer')
  results.push({ step: 'back-forward' })

  // (d) Kembali steps back to the list entry (no new entry, Forward still reaches the customer)
  await page.getByRole('button', { name: 'Kembali ke Pelanggan' }).click()
  await page.getByText('Pelanggan 26', { exact: true }).waitFor()
  check((await hashOf(page)) === listHash, `Kembali returns to the list as it was, got ${await hashOf(page)}`)
  check((await idxOf(page)) === listIdx, 'Kembali steps back instead of pushing a new list entry')
  await page.goForward()
  await page.getByRole('button', { name: 'Kembali ke Pelanggan' }).waitFor()
  results.push({ step: 'kembali-steps-back' })

  // (e) a customer pasted as a link has no entry to step back to: Kembali opens the list
  await deepLink(page, `#/pelanggan/daftar/${customerId(7)}`)
  await page.getByRole('button', { name: 'Kembali ke Pelanggan' }).click()
  await searchBox(page).waitFor()
  check((await hashOf(page)) === '#/pelanggan/daftar', `Kembali from a pasted link opens the list, got ${await hashOf(page)}`)
  results.push({ step: 'pasted-detail-kembali' })

  // (f) junk values fall back to the defaults
  await deepLink(page, '#/pelanggan/daftar?urut=zzz&hal=-3&tag=nope&per=7')
  await page.getByText('Pelanggan 1', { exact: true }).waitFor()
  check((await page.getByRole('button', { name: 'Belanja Tertinggi' }).getAttribute('aria-pressed')) === 'true', 'a junk sort shows the default')
  check(last().page === '1' && last().limit === String(PAGE_SIZE) && last().sort === 'belanja', `junk page, size and sort fall back: ${JSON.stringify(last())}`)
  results.push({ step: 'junk-values' })
  return results
}
