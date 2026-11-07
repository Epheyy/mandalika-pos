// Fase D5a: a Laporan table on the kit pager keeps its page across a reload and Back, and the Pengguna role delete asks
// through the ConfirmDialog and keeps the server's refusal inside it (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { openBackoffice, deepLink, navTo, clickTab } from './fixture'
import { BO_SHOT_VIEWPORTS, captureShot } from './shots'

const OUTLET = '00000000-0000-4000-8d5a-0000000000a1'
const ROLE_ID = '00000000-0000-4000-8d5a-0000000000b1'
const REASON = 'Role masih dipakai oleh 3 pengguna (uji)'
const user = { id: 'synthetic-admin', displayName: 'D5 Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

interface Calls {
  codeReport: URLSearchParams[]
  roleDeletes: number
}

async function mockApi(page: ScenarioPage) {
  const calls: Calls = { codeReport: [], roleDeletes: 0 }
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'D5 Outlet', isActive: true }] } })
    if (path.endsWith('/discount-code-report')) {
      calls.codeReport.push(url.searchParams)
      const pageNo = Number(url.searchParams.get('page') ?? 1)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const data = Array.from({ length: limit }, (_, i) => ({
        code: `KODE-${pageNo}-${i + 1}`, promotionName: 'Promo D5', redemptions: 2, valueGiven: 10000, remaining: 5, status: 'aktif',
      }))
      return route.fulfill({ json: { summary: { totalRedemptions: 240, totalValue: 1200000, distinctCodes: 120 }, data, meta: { total: 120, page: pageNo, limit } } })
    }
    if (path.endsWith('/custom-roles') && request.method() === 'GET') {
      return route.fulfill({ json: { data: [{ id: ROLE_ID, name: 'Supervisor D5', permissions: ['manage_products'], createdAt: '2026-01-03T05:00:00Z' }] } })
    }
    if (path.endsWith(`/custom-roles/${ROLE_ID}`) && request.method() === 'DELETE') {
      calls.roleDeletes += 1
      return route.fulfill({ status: 409, json: { error: REASON } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  return calls
}

const hashOf = (page: ScenarioPage) => page.evaluate(() => location.hash)

export const reportPagerFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const calls = await mockApi(page)
  await openBackoffice(page)
  await deepLink(page, '#/laporan/kode-diskon')
  await page.locator('nav[aria-label="Halaman"] [aria-current="page"]', { hasText: /^1$/ }).waitFor()
  check(calls.codeReport.some((q) => q.get('page') === '1' && q.get('limit') === '50'), 'first page asks for limit 50')
  check((await page.getByRole('combobox', { name: /Baris/ }).locator('option').count()) === 1, 'the fixed page size offers one size')
  results.push({ step: 'first-page' })

  await page.getByRole('button', { name: /Berikutnya/ }).click()
  await page.locator('nav[aria-label="Halaman"] [aria-current="page"]', { hasText: /^2$/ }).waitFor()
  await page.getByRole('cell', { name: 'KODE-2-1', exact: true }).waitFor()
  check(/hal=2/.test(await hashOf(page)), `page 2 is in the URL, got ${await hashOf(page)}`)
  check(calls.codeReport.some((q) => q.get('page') === '2' && q.get('limit') === '50'), 'page 2 asks for page=2 limit=50')
  results.push({ step: 'next-page' })

  await page.reload()
  await page.locator('nav[aria-label="Halaman"] [aria-current="page"]', { hasText: /^2$/ }).waitFor()
  await page.getByRole('cell', { name: 'KODE-2-1', exact: true }).waitFor()
  results.push({ step: 'reload-keeps-page' })

  // leave the report and come Back: the page is still 2
  await clickTab(page, 'export')
  await page.waitForFunction(() => location.hash.startsWith('#/laporan/ekspor'))
  await page.goBack()
  await page.locator('nav[aria-label="Halaman"] [aria-current="page"]', { hasText: /^2$/ }).waitFor()
  check(/hal=2/.test(await hashOf(page)), `Back keeps page 2, got ${await hashOf(page)}`)
  results.push({ step: 'back-keeps-page' })
  return results
}

export const roleDeleteFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const calls = await mockApi(page)
  await openBackoffice(page)
  await navTo(page, 'users')
  await page.locator('[data-tab-key="roles"]').click()
  await page.getByText('Supervisor D5', { exact: true }).waitFor()
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'b4b-pengguna-role', BO_SHOT_VIEWPORTS)

  await page.getByRole('button', { name: 'Hapus role Supervisor D5' }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.waitFor()
  check((await dialog.innerText()).includes('Hapus role Supervisor D5?'), 'the question names the role')
  check(calls.roleDeletes === 0, 'asking sends nothing')
  results.push({ step: 'asks-first' })

  await dialog.getByRole('button', { name: 'Hapus role' }).click()
  await dialog.getByRole('alert').filter({ hasText: REASON }).waitFor()
  check(calls.roleDeletes === 1, 'the delete was sent once')
  check(await dialog.isVisible(), 'a refused delete keeps the dialog open')
  results.push({ step: 'keeps-server-reason' })

  await dialog.getByRole('button', { name: 'Batal' }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByText('Supervisor D5', { exact: true }).waitFor()
  results.push({ step: 'cancel-closes' })
  return results
}
