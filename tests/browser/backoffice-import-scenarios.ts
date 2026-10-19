// A39 CSV import: preview with errors blocks Terapkan, a clean second preview enables it,
// apply sends Idempotency-Key + dryRun false + the preview's hash/summary, success text shows
// (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { BO } from './fixture'

const summary = (over: Partial<Record<'create' | 'update' | 'skip' | 'error' | 'warning' | 'newCategories', number>> = {}) =>
  ({ create: 0, update: 0, skip: 0, error: 0, warning: 0, newCategories: 0, ...over })

const report = (over: Record<string, unknown>) => ({
  kind: 'customers', delimiter: ',', fileSha256: 'sha-1', totalRows: 2,
  summary: summary(), fileIssues: [], issues: [], rows: [], ...over,
})

export const csvImportFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
  const user = { id: 'synthetic-admin', displayName: 'IM Admin', role: 'admin', outletId: null, permissions: [] }
  const badFile = 'Nama,Telepon\nAyu,\nBudi,081100000002\n'
  const goodFile = 'Nama,Telepon\nAyu,081100000001\nBudi,081100000002\n'
  const importCalls: Array<{ body: any; key: string | undefined }> = []

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const path = req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: 'outlet-a', name: 'IM Outlet', isActive: true }] } })
    if (path.endsWith('/customers/import') && req.method() === 'POST') {
      const body = req.postDataJSON()
      importCalls.push({ body, key: req.headers()['idempotency-key'] })
      if (body.dryRun && body.csv === badFile) {
        return route.fulfill({ json: { data: report({
          totalRows: 2, summary: summary({ create: 1, error: 1 }),
          issues: [{ row: 1, line: 2, column: 'Telepon', severity: 'error', code: 'required', message: 'Telepon wajib diisi' }],
          rows: [{ row: 1, line: 2, action: 'error', key: 'Ayu' }, { row: 2, line: 3, action: 'create', key: '081100000002' }],
        }) } })
      }
      if (body.dryRun) {
        return route.fulfill({ json: { data: report({
          fileSha256: 'sha-2', summary: summary({ create: 2 }),
          rows: [{ row: 1, line: 2, action: 'create', key: '081100000001' }, { row: 2, line: 3, action: 'create', key: '081100000002' }],
        }) } })
      }
      return route.fulfill({ json: { data: report({
        fileSha256: body.fileSha256, summary: body.expectedSummary, runId: 'run-1', appliedAt: new Date().toISOString(),
      }) } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await page.goto(BO)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('mandalika.backoffice.refresh', 'SYNTHETIC-NON-TOKEN')
    localStorage.setItem('mandalika.backoffice.loginDate', new Date().toLocaleDateString('sv-SE'))
  })
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 1000 })

  await page.getByRole('button', { name: 'Pelanggan', exact: true }).click()
  const picker = page.getByLabel('Impor dari file CSV')
  await picker.setInputFiles({ name: 'pelanggan.csv', mimeType: 'text/csv', buffer: Buffer.from(badFile) })

  // 1. The preview has a row error: the report is shown and Terapkan is disabled.
  await page.getByText('Telepon wajib diisi').waitFor()
  const apply = page.getByRole('button', { name: 'Terapkan', exact: true })
  check(await apply.isDisabled(), 'Terapkan must be disabled while the preview has errors')
  check(importCalls.length === 1 && importCalls[0].body.dryRun === true && importCalls[0].key === undefined, 'first call must be a dry run without a key')
  results.push({ step: 'errors-block-apply' })

  // 2. A second, clean file previews fine and enables Terapkan.
  await picker.setInputFiles({ name: 'pelanggan-baik.csv', mimeType: 'text/csv', buffer: Buffer.from(goodFile) })
  await page.getByText('pelanggan-baik.csv').waitFor()
  await page.getByText('Baru: 2').waitFor()
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Terapkan')
    return !!b && !(b as HTMLButtonElement).disabled
  })
  results.push({ step: 'clean-preview-enables-apply' })

  // 3. Apply sends the Idempotency-Key, dryRun false and the preview's hash and summary.
  await apply.click()
  await page.getByText(/Impor berhasil: 2 dibuat/).waitFor()
  const applyCall = importCalls[importCalls.length - 1]
  check(applyCall.body.dryRun === false, 'apply must send dryRun false')
  check(typeof applyCall.key === 'string' && applyCall.key.length >= 8, `Idempotency-Key missing: ${applyCall.key}`)
  check(applyCall.body.fileSha256 === 'sha-2' && applyCall.body.expectedSummary.create === 2, `apply body ${JSON.stringify(applyCall.body).slice(0, 200)}`)
  results.push({ step: 'apply', key: 'present', dryRun: false })

  // 4. The success text is on screen and the dialog offers Selesai.
  await page.getByRole('button', { name: 'Selesai' }).waitFor()
  results.push({ step: 'success-text' })
  return results
}
