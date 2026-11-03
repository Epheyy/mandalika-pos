// Pengaturan save bar, leave guard and merge-on-save (D1-P). Synthetic API, no real backend.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo, openTab, navItem } from './fixture'

const OUTLET = '00000000-0000-4000-8f6a-0000000000a1'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const METHODS = [
  { id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true },
  { id: 'qris', label: 'QRIS', isEnabled: true, isCash: false },
]
const SAVE_BAR = '[data-testid="save-bar"]'
const SAVED = 'Pengaturan disimpan · tablet mengambilnya saat sinkron berikutnya'

export const settingsGuardFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const puts: Array<Record<string, unknown>> = []
  const gets: string[] = []
  const server: Record<string, unknown> = {
    taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: METHODS,
    receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true,
    recipesEnabled: false, inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
  }
  // Another admin saves a new tax rate between this tab's load and its save: the next cache-bypassing GET sees it.
  let otherAdminTaxRate: number | null = null

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (url.pathname.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (url.pathname.endsWith('/settings/app')) {
      if (req.method() === 'PUT') {
        puts.push(JSON.parse(req.postData() ?? '{}') as Record<string, unknown>)
        Object.assign(server, puts[puts.length - 1])
        return route.fulfill({ json: { data: { ok: true } } })
      }
      gets.push(url.search)
      if (url.search.includes('_=') && otherAdminTaxRate !== null) { server.taxRate = otherAdminTaxRate; otherAdminTaxRate = null }
      return route.fulfill({ json: { data: server } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await openBackoffice(page)
  await openTab(page, 'settings', 'transaksi')

  // (0) opening the screen is not a change
  const tax = page.locator('input[type="number"]').first()
  await tax.waitFor()
  check((await tax.inputValue()) === '11', 'loaded tax rate')
  await page.getByRole('switch', { name: 'Bayar terpisah', exact: true }).waitFor()
  check((await page.locator(SAVE_BAR).count()) === 0, 'no save bar on open')
  results.push({ step: 'no-bar-on-open' })

  // (a) an edit shows the bar and the dirty cues; the sidebar asks first
  await page.getByRole('switch', { name: 'Cetak struk otomatis', exact: true }).click()
  await page.getByText('1 perubahan belum disimpan').waitFor()
  check((await page.locator('[data-dirty="true"]').count()) >= 1, 'tab dot shown')
  check((await page.locator('[data-changed="true"]').count()) >= 1, 'card cue shown')
  await navTo(page, 'dashboard')
  await page.getByRole('heading', { name: 'Simpan perubahan Pengaturan?' }).waitFor()
  await page.getByRole('button', { name: 'Tetap di sini', exact: true }).click()
  check((await page.getByRole('switch', { name: 'Cetak struk otomatis', exact: true }).getAttribute('aria-checked')) === 'true', 'stay keeps the edit')
  await page.getByText('1 perubahan belum disimpan').waitFor()
  await navTo(page, 'dashboard')
  await page.getByRole('button', { name: 'Buang perubahan', exact: true }).click()
  await navItem(page, 'settings').waitFor()
  await page.getByRole('heading', { name: 'Simpan perubahan Pengaturan?' }).waitFor({ state: 'detached' })
  check(puts.length === 0, 'nothing saved by the guard')
  results.push({ step: 'leave-guard' })

  // (b) stale merge: the server moved taxRate; our PUT carries the fresh rate plus only our own edit
  await openTab(page, 'settings', 'transaksi')
  await page.getByRole('switch', { name: 'Cetak struk otomatis', exact: true }).click()
  otherAdminTaxRate = 7
  const getsBefore = gets.length
  await page.getByRole('button', { name: 'Simpan perubahan', exact: true }).click()
  await page.getByText(SAVED).waitFor()
  check(puts.length === 1, `one save, got ${puts.length}`)
  const put = puts[0]
  check(put.taxRate === 7, `PUT carries the fresh taxRate, got ${String(put.taxRate)}`)
  check((put.receipt as Record<string, unknown>).autoPrint === true, 'PUT carries the edited receipt field')
  for (const k of ['recipesEnabled', 'inventoryApprovalRequired', 'documents', 'splitTenderEnabled']) check(!(k in put), `untouched present-only key ${k} is absent from the PUT`)
  check(gets.slice(getsBefore).filter((q) => q.includes('_=')).length >= 2, 'a fresh GET before and after the PUT')
  check((await tax.inputValue()) === '7', 'screen re-baselined to the fresh tax rate')
  check((await page.getByText('perubahan belum disimpan').count()) === 0, 'no pending changes after save')
  results.push({ step: 'stale-merge', body: put })

  // (c) the screen is in the URL: a reload stays on Pengaturan
  const hashNow = () => page.evaluate(() => location.hash)
  check((await hashNow()) === '#/pengaturan/transaksi', `hash is #/pengaturan/transaksi, got ${await hashNow()}`)
  await page.reload()
  await navItem(page, 'settings').waitFor()
  check((await navItem(page, 'settings').getAttribute('aria-current')) === 'page', 'reload keeps Pengaturan active')
  results.push({ step: 'reload-keeps-screen' })

  // (d) browser Back is guarded too: refused puts the hash back and keeps the edit, allowed leaves.
  // The previous entry must be another screen (Back between Pengaturan's own tabs is not a leave, see BO-ROUTE-GUARD).
  await navTo(page, 'dashboard')
  await page.evaluate(() => { location.hash = '#/pengaturan/transaksi' })
  await page.locator('input[type="number"]').first().waitFor()
  await page.getByRole('switch', { name: 'Cetak struk otomatis', exact: true }).click()
  await page.getByText('1 perubahan belum disimpan').waitFor()
  await page.goBack()
  await page.getByRole('heading', { name: 'Simpan perubahan Pengaturan?' }).waitFor()
  check((await hashNow()) === '#/pengaturan/transaksi', 'refused Back puts the hash back while asking')
  await page.getByRole('button', { name: 'Tetap di sini', exact: true }).click()
  check((await hashNow()) === '#/pengaturan/transaksi', 'hash still #/pengaturan/transaksi after Tetap di sini')
  check((await page.getByRole('switch', { name: 'Cetak struk otomatis', exact: true }).getAttribute('aria-checked')) === 'false', 'refused Back keeps the edit (the saved value was on, the edit turned it off)')
  await page.goBack()
  await page.getByRole('button', { name: 'Buang perubahan', exact: true }).click()
  await page.getByRole('heading', { name: 'Simpan perubahan Pengaturan?' }).waitFor({ state: 'detached' })
  check((await navItem(page, 'dashboard').getAttribute('aria-current')) === 'page', 'allowed Back lands on the previous screen')
  check(puts.length === 1, 'Back guard saved nothing')
  results.push({ step: 'back-guard' })
  return results
}
