// Fase D3b: Opname Mulai, Selesai and cancel ask first; Selesai names the net difference that will be applied
// (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { openBackoffice, deepLink } from './fixture'
import { BO_SHOT_VIEWPORTS, captureShot } from './shots'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const RUN_ID = '00000000-0000-4000-8f6b-0000000000e1'
const DROP_ID = '00000000-0000-4000-8f6b-0000000000e2'
const ING_COUNT_ID = '00000000-0000-4000-8f6b-0000000000e3'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

type Status = 'planned' | 'in_progress' | 'completed' | 'cancelled'
interface Call { id: string; kind: 'update' | 'complete'; body: unknown }
interface IngredientSave { id: string; items: { itemId: string; counted: number }[] }
const ingItem = (n: number, name: string, counted: number | null) => ({
  id: `00000000-0000-4000-8f6b-00000000f00${n}`, ingredientId: `00000000-0000-4000-8f6b-00000000a00${n}`, ingredientName: name, ingredientUnit: 'gr', counted,
})

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
  const ingredientSaves: IngredientSave[] = []
  // "Opname Bahan Uji" is in progress: Melati was saved earlier as 9, Mawar and Cendana were never counted.
  const ingredientCount = {
    id: ING_COUNT_ID, name: 'Opname Bahan Uji', status: 'in_progress' as Status, location: { kind: 'outlet', id: OUTLET, name: 'MV Outlet' },
    createdAt: '2026-01-04T05:00:00Z', plannedDate: '2026-01-04',
    items: [ingItem(1, 'Melati', 9), ingItem(2, 'Mawar', null), ingItem(3, 'Cendana', null)],
  }
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
    if (path.endsWith('/ingredient-stock-counts') && request.method() === 'GET') {
      // Like the real list endpoint (backend/internal/read/ingredient_stock_counts.go): the lines are NOT in the list.
      return route.fulfill({ json: { data: [{ ...ingredientCount, items: [] }], meta: { total: 1, page: 1, limit: 25 } } })
    }
    if (path.endsWith(`/ingredient-stock-counts/${ING_COUNT_ID}`) && request.method() === 'GET') {
      return route.fulfill({ json: { data: ingredientCount } })
    }
    if (path.endsWith(`/ingredient-stock-counts/${ING_COUNT_ID}/save`) && request.method() === 'PUT') {
      const body = request.postDataJSON() as { items: IngredientSave['items'] }
      ingredientSaves.push({ id: ING_COUNT_ID, items: body.items })
      for (const line of body.items) {
        const target = ingredientCount.items.find((i) => i.id === line.itemId)
        if (target) target.counted = line.counted
      }
      return route.fulfill({ json: { data: null } })
    }
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
  return { calls, ingredientSaves, ingredientCount }
}

export const opnameConfirmFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const { calls, ingredientSaves, ingredientCount } = await mockApi(page)
  await openBackoffice(page)
  await deepLink(page, '#/inventori/opname')
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
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'b3-opname', BO_SHOT_VIEWPORTS)
  results.push({ step: 'mulai-asks' })

  // (b) an unsaved edit (Parfum A 10 to 4) is saved first, then Selesai names the net the saved count gives
  // (10 to 4 and 5 to 6 = -5) before anything is applied
  const doneDialog = page.getByRole('alertdialog', { name: 'Selesaikan opname Opname Uji?' })
  // F28/F29: a decimal is refused with a message and never saved; the field stays readable in portrait (602x1006).
  const fieldA = page.getByLabel('Jumlah dihitung Parfum A 30ml')
  const updatesBefore = updates(RUN_ID).length
  await fieldA.fill('1.9')
  await fieldA.blur()
  await page.getByText('Hanya bilangan bulat').waitFor()
  await page.waitForTimeout(500)
  check(updates(RUN_ID).length === updatesBefore, 'a decimal count sends nothing')
  await page.getByRole('button', { name: 'Selesai', exact: true }).click()
  await page.getByText('Ada hitungan yang belum tersimpan').waitFor()
  check(!calls.some((c) => c.kind === 'complete'), 'Selesai with a refused value still showing completes nothing')
  await page.setViewportSize({ width: 602, height: 1006 })
  const box = await fieldA.boundingBox()
  check(box !== null && box.width >= 70, `the count field keeps its width in portrait, got ${box?.width}`)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await fieldA.fill('4')
  await page.getByText('Hanya bilangan bulat').waitFor({ state: 'detached' })
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

  // (e) ingredient Opname: Simpan sends only the line entered now. Melati (saved 9) and Cendana (never counted) are
  // not in the request, so Selesai later leaves Cendana alone instead of zeroing it.
  settings.recipesEnabled = true
  await deepLink(page, '#/inventori/opname/bahan')
  await page.getByText('Opname Bahan Uji').waitFor()
  await page.getByText('1/3 dihitung').waitFor()
  await page.getByRole('button', { name: 'Simpan', exact: true }).click()
  check(ingredientSaves.length === 0, `Simpan with nothing entered sends nothing, got ${JSON.stringify(ingredientSaves)}`)
  await page.getByRole('button', { name: 'Buka rincian Opname Bahan Uji', exact: true }).click()
  await page.getByLabel('Jumlah dihitung').nth(1).fill('5')
  await page.getByText('2/3 dihitung').waitFor()
  await page.getByRole('button', { name: 'Simpan', exact: true }).click()
  await page.getByText('2/3 dihitung').waitFor()
  check(
    ingredientSaves.length === 1 && ingredientSaves[0].items.length === 1 && ingredientSaves[0].items[0].counted === 5,
    `Simpan sends exactly the one entered line, got ${JSON.stringify(ingredientSaves)}`,
  )
  check(!ingredientSaves[0].items.some((i) => i.itemId === ingredientCount.items[0].id || i.itemId === ingredientCount.items[2].id), 'the saved and the uncounted lines are not sent')
  await page.getByRole('button', { name: 'Simpan', exact: true }).click()
  check(ingredientSaves.length === 1, 'a second Simpan with no new entry sends nothing')
  results.push({ step: 'ingredient-simpan-sends-only-entered-lines' })

  // (f) F33: a typed-but-unsaved quantity is not lost silently. Switching Bahan to Produk asks; "Lanjut edit" keeps the
  // value (also across collapse/reopen), "Tinggalkan dan buang" leaves and drops it. Nothing unsaved: no question.
  const leaveDialog = page.getByRole('alertdialog', { name: 'Tinggalkan hitungan?' })
  const rows = page.getByLabel('Jumlah dihitung')
  await page.locator('[data-tab-key="opname.produk"]').click()
  await page.getByRole('heading', { name: 'Opname Produk' }).waitFor()
  await page.locator('[data-tab-key="opname.bahan"]').click()
  await page.getByText('Opname Bahan Uji').waitFor()
  check((await leaveDialog.count()) === 0, 'a saved count asks nothing when the sub-tab is switched')
  await page.getByRole('button', { name: 'Buka rincian Opname Bahan Uji', exact: true }).click()
  await rows.nth(2).fill('2.5')
  await page.locator('tr', { has: rows.nth(2) }).getByText('Belum disimpan').waitFor()
  await page.locator('[data-tab-key="opname.produk"]').click()
  await leaveDialog.waitFor()
  check((await leaveDialog.getByText('1 bahan').count()) === 1, 'the question names the one unsaved row')
  check(await leaveDialog.getByRole('button', { name: 'Lanjut edit', exact: true }).evaluate((el) => el === document.activeElement), 'focus starts on Lanjut edit')
  await page.keyboard.press('Escape')
  await leaveDialog.waitFor({ state: 'detached' })
  check((await rows.nth(2).inputValue()) === '2.5', 'Escape keeps editing and the typed value')
  await page.getByRole('button', { name: 'Tutup rincian Opname Bahan Uji', exact: true }).click()
  await page.getByRole('button', { name: 'Buka rincian Opname Bahan Uji', exact: true }).click()
  check((await rows.nth(2).inputValue()) === '2.5', 'collapse and reopen keeps the unsaved value')
  await page.locator('[data-tab-key="opname.produk"]').click()
  await leaveDialog.getByRole('button', { name: 'Tinggalkan dan buang', exact: true }).click()
  await page.getByRole('heading', { name: 'Opname Produk' }).waitFor()
  check(ingredientSaves.length === 1, 'discarding never saves the entry')
  await page.locator('[data-tab-key="opname.bahan"]').click()
  await page.getByRole('button', { name: 'Buka rincian Opname Bahan Uji', exact: true }).click()
  check((await rows.nth(2).inputValue()) === '', 'the discarded entry is gone')
  results.push({ step: 'ingredient-unsaved-leave-guard' })

  return results
}
