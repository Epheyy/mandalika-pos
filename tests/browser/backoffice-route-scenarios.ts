// Fase D1b: routed tabs and views (deep links) and the leave guard against Forward, typed URLs and the screen's own
// tabs (synthetic API, no real backend). BO-SETTINGS-GUARD already covers a refused and an allowed Back.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo, navItem, clickTab, tabItem } from './fixture'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const TRANSFER_ID = '00000000-0000-4000-8f6b-0000000000c1'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

const EMPTY_SUMMARY = {
  from: null, to: null, outletId: null, totalSales: 0, totalOrders: 0, grossSales: 0, grossOrders: 0, totalRefunds: 0, refundedOrders: 0,
  netSales: 0, avgOrderValue: 0, byPaymentMethod: {}, grossByPaymentMethod: {}, refundsByPaymentMethod: {}, topProducts: [], dailySales: [],
}
const TRANSFER = {
  id: TRANSFER_ID, transferNo: 'TRF-DEEP-1', status: 'completed', source: { kind: 'warehouse', id: 'w1', name: 'Gudang Pusat' },
  dest: { kind: 'outlet', id: OUTLET, name: 'MV Outlet' }, items: [], createdAt: '2026-01-03T05:00:00Z',
}
const settings = (over: Record<string, unknown> = {}) => ({
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: false,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' }, ...over,
})

interface MockOptions {
  recipesEnabled?: boolean
  /** Holds the app-settings answer, like a slow network: Bahan only appears once it lands. */
  settingsDelayMs?: number
}

async function mockApi(page: ScenarioPage, opts: MockOptions = {}) {
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/settings/app')) {
      if (opts.settingsDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.settingsDelayMs))
      return route.fulfill({ json: { data: settings({ recipesEnabled: opts.recipesEnabled ?? false }) } })
    }
    if (path.endsWith('/reports/summary')) return route.fulfill({ json: { data: EMPTY_SUMMARY } })
    if (path.endsWith('/refund-report')) {
      return route.fulfill({ json: { summary: { count: 0, totalAmount: 0, flaggedCount: 0 }, data: [], meta: { total: 0, page: 1, limit: 50 } } })
    }
    if (path.endsWith('/inventory/overview') || path.endsWith('/inventory/ingredient-overview')) return route.fulfill({ json: { locations: [], rows: [] } })
    if (path.endsWith(`/transfers/${TRANSFER_ID}`)) return route.fulfill({ json: { data: TRANSFER } })
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
}

const hashOf = (page: ScenarioPage) => page.evaluate(() => location.hash)
const historyOf = (page: ScenarioPage) =>
  page.evaluate(() => ({ len: history.length, idx: (history.state as { idx?: number } | null)?.idx ?? null }))
const pressed = async (page: ScenarioPage, tabKey: string) => (await tabItem(page, tabKey).getAttribute('aria-pressed')) === 'true'
/** The breadcrumb's last item: the screen, or its tab when the screen has tabs. */
const crumb = (page: ScenarioPage) => page.locator('nav[aria-label="Posisi halaman"] [aria-current="page"]')

/** Land on a deep link the way a pasted URL does: set the hash, then load the page fresh. */
async function deepLink(page: ScenarioPage, hash: string) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.reload()
}

export const routeDeepLinkFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  await mockApi(page)
  await openBackoffice(page)
  await navItem(page, 'dashboard').waitFor()

  // (a) a tab is in the URL: #/laporan/refund survives a reload and fills the breadcrumb
  await deepLink(page, '#/laporan/refund')
  await tabItem(page, 'refund').waitFor()
  check(await pressed(page, 'refund'), 'reload keeps Refund')
  check((await hashOf(page)) === '#/laporan/refund', `hash stays #/laporan/refund, got ${await hashOf(page)}`)
  check(/Refund/.test((await crumb(page).textContent()) ?? ''), 'breadcrumb ends with the tab')
  results.push({ step: 'tab-deep-link' })

  // (b) a bare path or an unknown tab shows the first tab; a click writes the tab, Back and Forward move between tabs
  await navTo(page, 'reports')
  await tabItem(page, 'orders').waitFor()
  check(await pressed(page, 'orders'), 'bare #/laporan shows Transaksi')
  check((await hashOf(page)) === '#/laporan', 'a bare path is left as typed')
  await deepLink(page, '#/laporan/tidak-ada')
  await tabItem(page, 'orders').waitFor()
  check(await pressed(page, 'orders'), 'an unknown tab falls back to the first')
  await clickTab(page, 'export')
  check((await hashOf(page)) === '#/laporan/ekspor', `Ekspor click writes the path, got ${await hashOf(page)}`)
  await page.goBack()
  await page.waitForFunction(() => location.hash === '#/laporan/tidak-ada')
  check(await pressed(page, 'orders'), 'Back returns to the first tab')
  await page.goForward()
  await page.waitForFunction(() => location.hash === '#/laporan/ekspor')
  check(await pressed(page, 'export'), 'Forward returns to Ekspor')
  results.push({ step: 'bare-unknown-and-history' })

  // (c) a transfer detail is a path: #/inventori/transfer/<id> opens it after a reload, Kembali goes to the list
  await deepLink(page, `#/inventori/transfer/${TRANSFER_ID}`)
  await page.getByRole('heading', { name: 'TRF-DEEP-1' }).waitFor()
  check(await pressed(page, 'transfer'), 'the Transfer tab is on')
  check(/Transfer/.test((await crumb(page).textContent()) ?? ''), 'breadcrumb ends with Transfer')
  await page.getByRole('button', { name: 'Kembali', exact: true }).click()
  await page.getByRole('heading', { name: 'TRF-DEEP-1' }).waitFor({ state: 'detached' })
  check((await hashOf(page)) === '#/inventori/transfer', `Kembali goes to the list, got ${await hashOf(page)}`)
  results.push({ step: 'transfer-detail' })

  // (d) a tab that waits for a setting (Bahan needs recipesEnabled) shows the first tab, then lands on it, URL untouched
  await mockApi(page, { recipesEnabled: true, settingsDelayMs: 1500 })
  await deepLink(page, '#/inventori/bahan')
  await tabItem(page, 'stok').waitFor()
  check(await pressed(page, 'stok'), 'before the setting loads the first tab shows')
  check((await hashOf(page)) === '#/inventori/bahan', 'the URL is not rewritten meanwhile')
  await tabItem(page, 'bahan').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-tab-key="bahan"]')?.getAttribute('aria-pressed') === 'true')
  check((await tabItem(page, 'stok-masuk').count()) === 1, 'the Bahan inner tabs are on show')
  check((await hashOf(page)) === '#/inventori/bahan', 'the URL still names Bahan')
  results.push({ step: 'gated-tab-re-resolves' })
  return results
}

export const routeGuardFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  await mockApi(page)
  await openBackoffice(page)
  const dialog = page.getByRole('heading', { name: 'Simpan perubahan Pengaturan?' })
  const autoPrint = page.getByRole('switch', { name: 'Cetak struk otomatis', exact: true })
  const settingsReady = page.locator('input[type="number"]').first()

  await navItem(page, 'dashboard').waitFor()
  await navTo(page, 'reports') // idx 1
  await navTo(page, 'settings') // idx 2: #/pengaturan
  await clickTab(page, 'transaksi') // idx 3
  await settingsReady.waitFor()
  await autoPrint.click()
  await page.getByText('1 perubahan belum disimpan').waitFor()

  // (a) the screen's own tabs are not a leave: no question, the edit and its dot stay
  await clickTab(page, 'operasional') // idx 4
  check((await dialog.count()) === 0, 'a tab inside Pengaturan does not ask')
  check((await hashOf(page)) === '#/pengaturan/operasional', `tab writes the path, got ${await hashOf(page)}`)
  check((await page.locator('[data-tab-key="transaksi"] [data-dirty="true"]').count()) === 1, 'the dirty dot stays on Transaksi')
  await clickTab(page, 'transaksi') // idx 5
  check((await autoPrint.getAttribute('aria-checked')) === 'true', 'the edit survived the tab switch')
  results.push({ step: 'tabs-are-not-a-leave' })

  // (b) Back and Forward between the screen's own tabs do not ask either
  await page.goBack()
  await page.waitForFunction(() => location.hash === '#/pengaturan/operasional')
  await page.goForward()
  await page.waitForFunction(() => location.hash === '#/pengaturan/transaksi')
  check((await dialog.count()) === 0, 'Back/Forward inside the screen do not ask')
  check((await autoPrint.getAttribute('aria-checked')) === 'true', 'the edit is still there')
  results.push({ step: 'back-forward-inside-screen' })

  // (c) a typed URL out of the screen asks: refused keeps hash, entry and edit; allowed leaves as a new entry
  const before = await historyOf(page)
  await page.evaluate(() => { location.hash = '#/laporan/refund' })
  await dialog.waitFor()
  check((await hashOf(page)) === '#/pengaturan/transaksi', 'a refused typed URL puts the hash back while asking')
  await page.getByRole('button', { name: 'Tetap di sini', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  check((await hashOf(page)) === '#/pengaturan/transaksi', 'still on Transaksi after Tetap di sini')
  // The browser keeps the typed entry as a Forward entry (go() undoes it); the entry the screen sits on is unchanged.
  check((await historyOf(page)).idx === before.idx, 'a refused typed URL leaves the screen on its own entry')
  check((await autoPrint.getAttribute('aria-checked')) === 'true', 'refused typed URL keeps the edit')
  await page.evaluate(() => { location.hash = '#/laporan/refund' })
  await dialog.waitFor()
  await page.getByRole('button', { name: 'Buang perubahan', exact: true }).click()
  await tabItem(page, 'refund').waitFor()
  check(await pressed(page, 'refund'), 'the typed URL opened Laporan > Refund')
  check((await hashOf(page)) === '#/laporan/refund', 'hash is the typed URL')
  const leftAt = await historyOf(page)
  check(leftAt.idx === (before.idx ?? 0) + 1, 'the typed URL is a push')
  results.push({ step: 'typed-url' })

  // (d) Forward into a dirty screen's exit is guarded: back to Pengaturan (clean after the discard), edit, then Forward
  await page.goBack()
  await page.waitForFunction(() => location.hash === '#/pengaturan/transaksi')
  await settingsReady.waitFor()
  check((await autoPrint.getAttribute('aria-checked')) === 'false', 'the discarded edit is gone')
  await autoPrint.click()
  await page.getByText('1 perubahan belum disimpan').waitFor()
  const dirtyAt = await historyOf(page)
  await page.goForward()
  await dialog.waitFor()
  check((await hashOf(page)) === '#/pengaturan/transaksi', 'a refused Forward puts the hash back while asking')
  await page.getByRole('button', { name: 'Tetap di sini', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  check(JSON.stringify(await historyOf(page)) === JSON.stringify(dirtyAt), 'a refused Forward leaves history where it was')
  check((await autoPrint.getAttribute('aria-checked')) === 'true', 'refused Forward keeps the edit')
  await page.goForward()
  await dialog.waitFor()
  await page.getByRole('button', { name: 'Buang perubahan', exact: true }).click()
  await tabItem(page, 'refund').waitFor()
  check((await hashOf(page)) === '#/laporan/refund', 'an allowed Forward lands on the entry it pointed to')
  check((await historyOf(page)).idx === leftAt.idx, 'Forward reused the same entry, nothing was pushed')
  results.push({ step: 'forward-guard' })
  return results
}
