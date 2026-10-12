// Head office resolves a parked tablet item (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { BO } from './fixture'

const KEY = 'devA:00000000-0000-4000-8c00-0000000000a1'

export const reviewResolveFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
  const now = new Date().toISOString()
  const user = { id: 'synthetic-admin', displayName: 'RV Admin', role: 'admin', outletId: null, permissions: [] }
  const item = {
    idempotencyKey: KEY, outletId: 'outlet-a', outletName: 'RV Outlet', capturedOutletId: 'outlet-a', capturedOutletName: 'RV Outlet',
    type: 'refund', reviewCode: 'forbidden', reviewReason: 'tidak berwenang', lastError: null, ownerUserId: null, ownerName: 'Kasir RV',
    payload: { orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', reason: 'rusak' },
    clientCreatedAt: now, firstReportedAt: now, lastReportedAt: now, reportedByName: 'Kasir RV',
    resolvedAt: null, resolvedByName: null, resolutionNote: null, appliedOnServer: false,
  }
  const state = { resolved: false, resolveBody: null as unknown, resolvePath: '' }
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const path = req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: 'outlet-a', name: 'RV Outlet', isActive: true }] } })
    if (path.endsWith('/resolve') && req.method() === 'POST') {
      state.resolved = true
      state.resolvePath = path
      state.resolveBody = req.postDataJSON()
      return route.fulfill({ json: { data: { idempotencyKey: KEY, resolvedAt: now, resolvedByName: 'RV Admin', note: 'refund manual' } } })
    }
    if (path.endsWith('/sync-review-items')) {
      const open = !state.resolved
      return route.fulfill({ json: { data: open ? [item] : [], meta: { total: open ? 1 : 0, page: 1, limit: 25 }, openCount: open ? 1 : 0 } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await page.goto(BO)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('mandalika.backoffice.refresh', 'SYNTHETIC-NON-TOKEN')
    localStorage.setItem('mandalika.backoffice.loginDate', new Date().toISOString().slice(0, 10))
  })
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 1000 })

  const navButton = page.getByRole('button', { name: /Tinjauan Sinkron/ })
  await navButton.waitFor()
  await page.getByLabel('1 item terbuka').waitFor()
  results.push({ step: 'badge', openCount: 1 })

  await navButton.click()
  await page.getByRole('button', { name: 'Terbuka (1)' }).waitFor()
  // The reason text also appears in the filter <select>; assert on the row button instead.
  const row = page.getByRole('button', { name: /Refund · Ditolak: tidak berwenang \/ PIN salah/ })
  await row.waitFor()
  results.push({ step: 'list', row: 'Refund · forbidden' })

  await row.click()
  // exact: the raw JSON <pre> also contains the receipt number.
  await page.getByText('BSD-G0007', { exact: true }).waitFor()
  await page.getByLabel('Catatan penyelesaian').fill('  refund manual  ')
  await page.getByRole('button', { name: 'Tandai selesai' }).click()
  await page.getByText('Tidak ada item terbuka').waitFor()
  check(JSON.stringify(state.resolveBody) === JSON.stringify({ note: 'refund manual' }), `resolve body ${JSON.stringify(state.resolveBody)}`)
  check(state.resolvePath.endsWith(`/sync-review-items/${encodeURIComponent(KEY)}/resolve`), `resolve path ${state.resolvePath}`)
  results.push({ step: 'resolve', body: state.resolveBody, path: state.resolvePath })

  await page.getByLabel('1 item terbuka').waitFor({ state: 'detached' })
  results.push({ step: 'badge-cleared', openCount: 0 })
  return results
}
