// Fase D3b: Opname Mulai, Selesai and cancel ask first; Selesai names the net difference that will be applied
// (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { openBackoffice } from './fixture'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const RUN_ID = '00000000-0000-4000-8f6b-0000000000e1'
const DROP_ID = '00000000-0000-4000-8f6b-0000000000e2'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

type Status = 'planned' | 'in_progress' | 'completed' | 'cancelled'
interface Call { id: string; kind: 'update' | 'complete'; body: unknown }

const item = (productId: string, name: string, frozenQty: number, actualQty: number | null) => ({
  productId, productName: name, variantSize: '30ml', sku: `SKU-${productId}`, frozenQty, actualQty,
})
const count = (id: string, name: string, items: ReturnType<typeof item>[], plannedDate: string) => ({
  id, name, status: 'planned' as Status, outletId: OUTLET, items, createdBy: 'u1', createdAt: `${plannedDate}T05:00:00Z`, plannedDate,
})
const settings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: false,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
}

/** Two counts: "Opname Uji" (lines 10 to 7 and 5 to 6, net -2) and "Opname Batal". Both start planned. */
async function mockApi(page: ScenarioPage) {
  const calls: Call[] = []
  const counts = {
    [RUN_ID]: count(RUN_ID, 'Opname Uji', [item('p1', 'Parfum A', 10, 7), item('p2', 'Parfum B', 5, 6)], '2026-01-03'),
    [DROP_ID]: count(DROP_ID, 'Opname Batal', [item('p3', 'Parfum C', 4, null)], '2026-01-02'),
  }
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/settings/app')) return route.fulfill({ json: { data: settings } })
    if (path.endsWith('/stock-counts') && request.method() === 'GET') {
      const data = Object.values(counts)
      return route.fulfill({ json: { data, meta: { total: data.length, page: 1, limit: 25 } } })
    }
    const one = /\/stock-counts\/([^/]+)(\/complete)?$/.exec(path)
    const found = one ? counts[one[1] as keyof typeof counts] : undefined
    if (one && found) {
      if (one[2] && request.method() === 'POST') {
        calls.push({ id: found.id, kind: 'complete', body: request.postDataJSON() })
        found.status = 'completed'
        return route.fulfill({ json: { data: found } })
      }
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { status?: Status; items?: { productId: string; variantSize: string; actualQty?: number | null }[] }
        calls.push({ id: found.id, kind: 'update', body })
        if (body.status) found.status = body.status
        for (const line of body.items ?? []) {
          const target = found.items.find((i) => i.productId === line.productId && i.variantSize === line.variantSize)
          if (target) target.actualQty = line.actualQty ?? null
        }
        return route.fulfill({ json: { data: found } })
      }
      if (request.method() === 'GET') return route.fulfill({ json: { data: found } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  return { calls }
}

export const opnameConfirmFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const { calls } = await mockApi(page)
  await openBackoffice(page)
  await page.evaluate(() => { location.hash = '#/inventori/opname' })
  await page.reload()
  await page.getByRole('heading', { name: 'Opname Produk' }).waitFor()
  const updates = (id: string) => calls.filter((c) => c.id === id && c.kind === 'update')
  const statusOf = (c: Call) => (c.body as { status?: string }).status

  // (a) Mulai asks first. Both counts are planned, so the first Mulai button is the newest ("Opname Uji").
  const startDialog = page.getByRole('alertdialog', { name: 'Mulai opname Opname Uji?' })
  await page.getByRole('button', { name: 'Mulai', exact: true }).first().click()
  await startDialog.waitFor()
  await startDialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await startDialog.waitFor({ state: 'detached' })
  check(calls.length === 0, 'Batal on Mulai sends nothing')
  await page.getByRole('button', { name: 'Mulai', exact: true }).first().click()
  await startDialog.getByRole('button', { name: 'Mulai opname', exact: true }).click()
  await page.getByRole('button', { name: 'Selesai', exact: true }).waitFor()
  check(updates(RUN_ID).length === 1 && statusOf(updates(RUN_ID)[0]) === 'in_progress', `one start update, got ${JSON.stringify(calls)}`)
  results.push({ step: 'mulai-asks' })

  // (b) an unsaved edit (Parfum A 10 to 4) is saved first, then Selesai names the net the saved count gives
  // (10 to 4 and 5 to 6 = -5) before anything is applied
  const doneDialog = page.getByRole('alertdialog', { name: 'Selesaikan opname Opname Uji?' })
  await page.getByLabel('Jumlah dihitung Parfum A 30ml').fill('4')
  await page.getByRole('button', { name: 'Selesai', exact: true }).click()
  await doneDialog.waitFor()
  const text = (await doneDialog.textContent()) ?? ''
  check(text.includes('selisih bersih -5') && text.includes('berkurang 5 unit') && text.includes('2 baris yang dihitung'), `the dialog states the saved net, got: ${text}`)
  check(!calls.some((c) => c.kind === 'complete'), 'asking completes nothing')
  await doneDialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await doneDialog.waitFor({ state: 'detached' })
  check(!calls.some((c) => c.kind === 'complete'), 'Batal on Selesai completes nothing')
  results.push({ step: 'selesai-names-net-and-batal-completes-nothing' })

  // (c) confirming completes the count exactly once
  await page.getByRole('button', { name: 'Selesai', exact: true }).click()
  await doneDialog.getByRole('button', { name: 'Selesaikan opname', exact: true }).click()
  await doneDialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Batalkan opname Opname Uji' }).waitFor({ state: 'detached' })
  check(calls.filter((c) => c.kind === 'complete').length === 1, 'one complete call')
  results.push({ step: 'confirm-completes-once' })

  // (d) cancelling a count asks first; Kembali sends nothing, confirming cancels it
  const dropDialog = page.getByRole('alertdialog', { name: 'Batalkan opname Opname Batal?' })
  await page.getByRole('button', { name: 'Batalkan opname Opname Batal' }).click()
  await dropDialog.waitFor()
  await dropDialog.getByRole('button', { name: 'Kembali', exact: true }).click()
  await dropDialog.waitFor({ state: 'detached' })
  check(updates(DROP_ID).length === 0, 'Kembali on a cancel sends nothing')
  await page.getByRole('button', { name: 'Batalkan opname Opname Batal' }).click()
  await dropDialog.getByRole('button', { name: 'Batalkan opname', exact: true }).click()
  await dropDialog.waitFor({ state: 'detached' })
  check(updates(DROP_ID).length === 1 && statusOf(updates(DROP_ID)[0]) === 'cancelled', 'one cancel update')
  results.push({ step: 'cancel-asks' })

  return results
}
