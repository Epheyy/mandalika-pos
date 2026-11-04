import { test, expect, evidence, POS, BO, openBackoffice, type ScenarioPage } from './fixture'
import { setupPos, qualifyPos, posBoundaries, physicalQueue, guestSales, addCustomer, posRecap, posAutoPull, posStockDrift, posLineSheet, posPromoSheet, posCustomerProfile, posHeldOrders, posGiveaway } from './pos-scenarios'
import { setupBackoffice, backofficeChecks, transactionsChecks, qualifyBackoffice, reportsRaces } from './backoffice-scenarios'
import { reviewResolveFlow } from './backoffice-review-scenarios'
import { csvImportFlow } from './backoffice-import-scenarios'
import { stockCardFlow } from './backoffice-stockcard-scenarios'
import { refundReportFlow, adminPartialRefundFlow } from './backoffice-refund-scenarios'
import { splitOrderFlow, splitToggleFlow } from './backoffice-split-scenarios'
import { settingsGuardFlow } from './backoffice-settings-scenarios'
import { routeDeepLinkFlow, routeGuardFlow } from './backoffice-route-scenarios'
import { routeBackFlow } from './backoffice-back-scenarios'
import { customersListFlow } from './backoffice-customers-scenarios'
import { bahanDaftarFlow } from './backoffice-bahan-scenarios'
import { productsListFlow } from './backoffice-products-scenarios'
import { promotionsFlow } from './backoffice-promotions-scenarios'
import { transferConfirmFlow } from './backoffice-transfer-scenarios'
import { opnameConfirmFlow } from './backoffice-opname-scenarios'
import { catalogueIdleFlow } from './backoffice-catalogue-scenarios'
import { dashboardAggregateFlow } from './backoffice-dashboard-scenarios'
import { approvalsErpFlow } from './backoffice-d3c-scenarios'
import { reportPagerFlow, roleDeleteFlow } from './backoffice-d5a-scenarios'
import { posRequisition } from './pos-requisition-scenarios'
import { posSplitTender, posSplitOffline, posSplitRefund, posSplitOff, posSplitDraft } from './pos-split-scenarios'

test('BO-SEMANTIC authoring rejects overlap and preserves valid edit duplicate toggle', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  await openBackoffice(p, { viewport: false })
  const result = await qualifyBackoffice(p)
  expect(result).toHaveLength(6)
  await evidence(info, result)
})

test('BO-PAGES-CSV complete dashboard CSV shift exports filters and later page failure', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupBackoffice(p)
  const result = await backofficeChecks(p)
  expect(result).toHaveLength(5)
  await evidence(info, result)
})

test('BO-PAGES-XLSX complete transaction exports and later page failure', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupBackoffice(p)
  const result = await transactionsChecks(p)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

for (const failure of [false, true]) test(`BO-RACE-${failure ? 'ERROR' : 'SUCCESS'} B survives late A complete cohort`, async ({ page }, info) => {
  const result = await reportsRaces(page as ScenarioPage, failure)
  expect(result.results).toHaveLength(1)
  expect(result.results[0].passed).toBe(true)
  expect(result.results[0].heldAPage2Responses).toBeGreaterThan(0)
  await evidence(info, result)
})

for (const [id, run, count] of [
  ['POS-PICKERS', qualifyPos, 10], ['POS-INVALIDATION', posBoundaries, 9],
  ['POS-PHYSICAL-QUEUE', physicalQueue, 5], ['POS-GUEST', guestSales, 10],
] as const) test(`${id} accepted rendered flow and synthetic evidence`, async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  const result = await run(p)
  expect(result).toHaveLength(count)
  await evidence(info, result)
})

test('POS-CUSTOMER-CREATE new customer and registered sale retain their link', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  await evidence(info, await addCustomer(p))
})

test('POS-AUTOPULL a version bump is pulled automatically only while the cart is empty', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  const result = await posAutoPull(p)
  expect(result).toHaveLength(3)
  await evidence(info, result)
})

test('POS-STOCKDRIFT a foreign stock bump is pulled once, silently, without a version change', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  const result = await posStockDrift(p)
  expect(result).toHaveLength(2)
  await evidence(info, result)
})

test('POS-LINE-SHEET a size row adds one unit in four taps to a cash sale; the line sheet edits qty, size and removal', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  const result = await posLineSheet(p)
  expect(result).toHaveLength(2)
  await evidence(info, result)
})

test('POS-PROMO-SHEET one Promo & Diskon door with the manual discount inline; Kosongkan asks before clearing', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  const result = await posPromoSheet(p)
  expect(result).toHaveLength(2)
  await evidence(info, result)
})

test('POS-CUSTOMER-PROFILE the chip, the Profil Pelanggan sheet and Ulangi add the last sale paid lines', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  const result = await posCustomerProfile(p)
  expect(result).toHaveLength(2)
  await evidence(info, result)
})

test('POS-GIVEAWAY the outlet giveaway is a HADIAH/GRATIS cart and receipt line, not an order line, and the bag tile stock drops by one', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p, { giveaway: { stock: 50 } })
  const result = await posGiveaway(p)
  expect(result).toHaveLength(3)
  await evidence(info, result)
})

test('POS-HELD-ORDERS a cart is saved under a name, found again from the menu, restored and paid', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  const result = await posHeldOrders(p)
  expect(result).toHaveLength(2)
  await evidence(info, result)
})

test('POS-RECAP all pages cached and actual panel remount keeps complete snapshot', async ({ page }, info) => {
  const p = page as ScenarioPage
  // The checks read recorded totals; blind count (default ON since 2026-11-05) hides them until counted.
  await p.addInitScript(() => { localStorage.setItem('pos_blindCount', '0') })
  await setupPos(p)
  await p.getByRole('button', { name: 'Menu', exact: true }).click()
  await evidence(info, await posRecap(p))
})

test('BO-REVIEW-RESOLVE head office resolves a parked tablet item and the badge clears', async ({ page }, info) => {
  const result = await reviewResolveFlow(page as ScenarioPage)
  expect(result).toHaveLength(5)
  await evidence(info, result)
})

test('BO-CSV-IMPORT preview errors block apply, a clean preview applies with an idempotency key', async ({ page }, info) => {
  const result = await csvImportFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-STOCK-CARD summary row opens the kartu stok, rows page, Hadiah chip filters, CSV downloads', async ({ page }, info) => {
  const result = await stockCardFlow(page as ScenarioPage)
  expect(result).toHaveLength(11)
  await evidence(info, result)
})

test('BO-REFUND-LIST Laporan Refund shows one row per refund with claimed amount and warning, flag and paging reach the API, per-refund CSV downloads', async ({ page }, info) => {
  const result = await refundReportFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-REFUND-ADMIN-PARTIAL admin picks one unit on one line, confirms, and posts the per-line shape; the order shows Refund ke-1 and the remainder', async ({ page }, info) => {
  const result = await adminPartialRefundFlow(page as ScenarioPage)
  expect(result).toHaveLength(3)
  await evidence(info, result)
})

test('BO-SPLIT-ORDER Split-Payment shows in list and detail lines, filters by Split-Payment, posts the chosen refund payout, and lands in the CSV', async ({ page }, info) => {
  const result = await splitOrderFlow(page as ScenarioPage)
  expect(result).toHaveLength(6)
  await evidence(info, result)
})

test('BO-SPLIT-TOGGLE Bayar terpisah is off by default with the D-50 warning, asks before switching on, refuses the reserved id, and saves the flag', async ({ page }, info) => {
  const result = await splitToggleFlow(page as ScenarioPage)
  expect(result).toHaveLength(5)
  await evidence(info, result)
})

test('BO-SETTINGS-GUARD Pengaturan shows no save bar on open, guards leaving with unsaved edits, and saves only changed fields merged onto a fresh GET', async ({ page }, info) => {
  const result = await settingsGuardFlow(page as ScenarioPage)
  expect(result).toHaveLength(5)
  await evidence(info, result)
})

test('BO-ROUTE-DEEPLINK a tab or view in the hash path survives a reload, a bare or unknown tab shows the first, Back and Forward move between tabs, and a gated tab re-resolves when its setting loads', async ({ page }, info) => {
  const result = await routeDeepLinkFlow(page as ScenarioPage)
  expect(result).toHaveLength(9)
  await evidence(info, result)
})

test('BO-ROUTE-GUARD a dirty Pengaturan keeps its own tabs unguarded and asks for a typed URL or a Forward that leaves it, refused keeps the hash, history and edit', async ({ page }, info) => {
  const result = await routeGuardFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-ROUTE-BACK Pelanggan list filters and page are URL state, opening a customer is a path, Back and Kembali return to the list as it was (same search, sort, page and request), Forward returns to the customer, a pasted customer link opens the list on Kembali, and junk values fall back to the defaults', async ({ page }, info) => {
  const result = await routeBackFlow(page as ScenarioPage)
  expect(result).toHaveLength(6)
  await evidence(info, result)
})

test('BO-CUSTOMERS-LIST Pelanggan is a captioned table over the server page and its search and page size are URL state that survive a reload, the edit slide-over asks one question for Escape, the x, Batal and browser Back on unsaved work, a refused save and a refused delete stay visible, and delete asks first', async ({ page }, info) => {
  const result = await customersListFlow(page as ScenarioPage)
  expect(result).toHaveLength(6)
  await evidence(info, result)
})

test('BO-BAHAN-DAFTAR Bahan Daftar sends the category as a server parameter so the filter covers every page (60 matching rows over three pages, later pages keep it), the category is URL state that survives a reload, and delete blocks a used ingredient with its variants listed and keeps a refusal reason in the dialog', async ({ page }, info) => {
  const result = await bahanDaftarFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-PRODUCTS-LIST Produk filters and paging are server requests and URL state that survive a reload, a page past the end steps back, the export carries every matching row, and the editor slide-over guards unsaved work with one question, closes silently after a save, shows field errors and layers the recipe editor', async ({ page }, info) => {
  const result = await productsListFlow(page as ScenarioPage)
  expect(result).toHaveLength(13)
  await evidence(info, result)
})

test('BO-PROMO-LIST Promosi and Kode Diskon filters and paging are server requests and URL state that survive a reload and feed the export, the status Switch asks before turning on and turning off undoes from a fresh read, an untouched edit sends every field back, Buat Massal asks with the count before creating active codes, and a refused save, delete or batch stays visible', async ({ page }, info) => {
  const result = await promotionsFlow(page as ScenarioPage)
  expect(result).toHaveLength(19)
  await evidence(info, result)
})

test('BO-TRANSFER-CONFIRM Kirim and Batalkan ask first, Batal leaves the draft, a refused send keeps the dialog and retries with the same key, a transfer changed under the dialog is refused, and a confirm calls the write once', async ({ page }, info) => {
  const result = await transferConfirmFlow(page as ScenarioPage)
  expect(result).toHaveLength(5)
  await evidence(info, result)
})

test('BO-OPNAME-CONFIRM Mulai, Selesai and cancel on a product Opname ask first, Selesai names the net difference, Batal changes nothing, and a confirm writes once', async ({ page }, info) => {
  const result = await opnameConfirmFlow(page as ScenarioPage)
  expect(result).toHaveLength(5)
  await evidence(info, result)
})

test('BO-CATALOGUE-CACHE the whole product list is read once per outlet scope, not on every 12 s poll: Opname, Ringkasan and Pelanggan stay quiet while idle, Tambah opname snapshots live stock, and the Ringkasan order numbers keep their poll and their value', async ({ page }, info) => {
  const result = await catalogueIdleFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-DASHBOARD-AGGREGATE Ringkasan reads one server aggregate per poll instead of every order of the period, shows the same numbers, and falls back to the order lists on a backend without the route', async ({ page }, info) => {
  const result = await dashboardAggregateFlow(page as ScenarioPage)
  expect(result).toHaveLength(3)
  await evidence(info, result)
})

test('BO-D3C-APPROVALS-ERP Persetujuan Stok filters are URL state that leave the badge alone, and the ERP relay run and retry ask first and call the server once', async ({ page }, info) => {
  const result = await approvalsErpFlow(page as ScenarioPage)
  expect(result).toHaveLength(8)
  await evidence(info, result)
})

test('BO-D5A-REPORT-PAGER a Laporan table on the kit pager asks the server for its fixed page size, and page 2 survives next, a reload and Back', async ({ page }, info) => {
  const result = await reportPagerFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-D5A-ROLE-DELETE Pengguna role delete asks in a ConfirmDialog, sends once, and keeps the server reason inside the open dialog', async ({ page }, info) => {
  const result = await roleDeleteFlow(page as ScenarioPage)
  expect(result).toHaveLength(3)
  await evidence(info, result)
})

// Independent test definitions: removing a registry row must not also remove its test.
for (const [id, description] of [
  [
    "HOOK-01",
    "01 B success then A success"
  ],
  [
    "HOOK-02",
    "02 A resolves while B pending"
  ],
  [
    "HOOK-03",
    "03 A error after B success"
  ],
  [
    "HOOK-04",
    "04 A success after B error"
  ],
  [
    "HOOK-05",
    "05 rapid A B C"
  ],
  [
    "HOOK-06",
    "06 overlapping same-scope polls"
  ],
  [
    "HOOK-07",
    "07a manual then interval"
  ],
  [
    "HOOK-08",
    "07b interval then manual"
  ],
  [
    "HOOK-09",
    "08 switch clears data and error"
  ],
  [
    "HOOK-10",
    "09 unmount pending"
  ],
  [
    "HOOK-11",
    "10 stable scope SWR success error refetch"
  ],
  [
    "HOOK-12",
    "11 A26 complete multi-page A after B"
  ],
  [
    "HOOK-13",
    "14 old interval after cleanup cannot start"
  ]
] as const) {
  test(`${id} ${description}`, async ({ page }, info) => {
    await page.goto(`${BO}/tests/polling-harness.html`)
    await page.waitForFunction(() => !!window.runPollingTests)
    const result = await page.evaluate(name => window.runPollingTests(name), description)
    expect(result.total).toBe(1)
    expect(result.results[0].name).toBe(description)
    expect(result.results[0].error).toBeUndefined()
    expect(result.passed).toBe(1)
    await evidence(info, result)
  })
}

test('S0A-DIAGNOSTICS repeated share cancellation and failures keep unresolved operations', async ({ page }, info) => {
  await page.goto(`${POS}/tests/failed-diagnostics/`)
  await page.getByRole('button', { name: '2 perlu ditinjau', exact: true }).click()
  const outcomes: object[] = []
  for (const scenario of ['share success', 'share success', 'cancel', 'share failure', 'clipboard failure']) {
    await page.getByLabel('Diagnostic outcome').selectOption(scenario)
    await page.getByRole('button', { name: 'Bagikan log', exact: true }).click()
    await expect.poll(async () => JSON.parse(await page.locator('pre').innerText()).exports).toBe(outcomes.length + 1)
    const current = JSON.parse(await page.locator('pre').innerText())
    expect(current).toMatchObject({ retained: 2, unchanged: true, reconstructed: true, failed: 2 })
    await expect(page.getByRole('button', { name: '2 perlu ditinjau', exact: true })).toBeVisible()
    outcomes.push({ scenario, current, message: await page.getByRole('status').innerText() })
  }
  await evidence(info, outcomes)
})

test('S0B-REFUND-RETENTION denied original refund survives export reconstruction and manual retry', async ({ page }, info) => {
  await page.goto(`${POS}/tests/refund-permission/`)
  const current = async () => JSON.parse(await page.getByLabel('Retention evidence').innerText())
  const original = await current()
  await page.getByRole('button', { name: 'Deliver five permission denials' }).click()
  await expect.poll(async () => (await current()).failed).toBe(1)
  const parked = await current()
  await page.getByRole('button', { name: '1 perlu ditinjau', exact: true }).click()
  await page.getByRole('button', { name: 'Bagikan log', exact: true }).click()
  await expect.poll(async () => (await current()).exports).toBe(1)
  expect((await current()).retained).toEqual(parked.retained)
  await page.getByRole('button', { name: 'Reconstruct from same storage' }).click()
  expect((await current()).retained).toEqual(parked.retained)
  await page.getByRole('button', { name: 'Restore synthetic permission' }).click()
  await page.getByRole('button', { name: '1 perlu ditinjau', exact: true }).click()
  await page.getByRole('button', { name: 'Coba lagi', exact: true }).click()
  await expect.poll(async () => (await current()).retained.length).toBe(0)
  const final = await current()
  expect(final.simulatedMutationCalls).toBe(1)
  expect(final.deliveries.at(-1)[0].idempotencyKey).toBe(parked.retained[0].idempotencyKey)
  await evidence(info, { original, parked, final })
})

test('C2-PARKED-PER-ITEM Coba lagi on one parked sale leaves the other parked; Tandai sudah ditangani hides without deleting', async ({ page }, info) => {
  await page.goto(`${POS}/tests/parked-per-item/`)
  const current = async () => JSON.parse(await page.getByLabel('Per-item evidence').innerText())
  const keyA = 'synthetic-device:order-a'
  const keyB = 'synthetic-device:order-b'
  expect(await current()).toMatchObject({ parked: [keyA, keyB], queued: [], stored: 2 })
  await page.getByRole('button', { name: '2 perlu ditinjau', exact: true }).click()
  await expect(page.getByTestId('review-row')).toHaveCount(2)
  await expect(page.getByTestId('queue-counts')).toContainText('2 perlu ditinjau')

  // Retry only row A.
  await page.locator(`[data-testid="review-row"][data-key="${keyA}"]`).getByRole('button', { name: /^Coba lagi/ }).click()
  await expect.poll(async () => (await current()).parked).toEqual([keyB])
  const afterRetry = await current()
  expect(afterRetry.stored).toBe(2)
  expect(afterRetry.queued.concat(afterRetry.parked)).toEqual(expect.arrayContaining([keyA, keyB]))

  // Acknowledge row B: hidden from the sheet, still stored, still parked in the outbox.
  await page.locator(`[data-testid="review-row"][data-key="${keyB}"]`).getByRole('button', { name: 'Tandai sudah ditangani', exact: true }).click()
  await expect(page.locator(`[data-testid="review-row"][data-key="${keyB}"]`)).toHaveCount(0)
  const final = await current()
  expect(final).toMatchObject({ parked: [keyB], stored: 2, acknowledged: [keyB] })
  await evidence(info, { afterRetry, final })
})

test('POS-OFFLINE-RETURN a sale made offline is found after a reload, reprinted once, refunded by uuid and synced in order', async ({ page }, info) => {
  await page.goto(`${POS}/tests/offline-return/`)
  const current = async () => JSON.parse(await page.getByLabel('Offline return evidence').innerText())
  expect(await current()).toMatchObject({ net: false, pending: 0, outboxOrders: 0 })

  // Offline sale, then a real reload: the receipt must survive on the tablet.
  await page.getByRole('button', { name: 'Jual offline (simulasi)', exact: true }).click()
  await expect.poll(async () => (await current()).pending).toBe(1)
  await page.reload()
  const afterReload = await current()
  expect(afterReload).toMatchObject({ net: false, pending: 1, outboxOrders: 1, batches: [] })

  // "Struk di tablet ini": search by number only, never by customer.
  await page.getByRole('button', { name: 'Buka Struk di tablet ini', exact: true }).click()
  const panel = page.getByTestId('local-receipts')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('local-receipt-row')).toHaveCount(1)
  await panel.getByLabel('Cari nomor struk').fill('Budi')
  await expect(panel.getByTestId('local-receipt-row')).toHaveCount(0)
  await panel.getByLabel('Cari nomor struk').fill('har-0001')
  const row = panel.getByTestId('local-receipt-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('HAR-0001')
  await expect(row).toContainText('Tersimpan di tablet')
  expect(await panel.innerText()).not.toMatch(/Budi|cust-secret/)

  // Reprint: one print, no new outbox entry.
  await row.getByRole('button', { name: 'Cetak Ulang', exact: true }).click()
  await expect.poll(async () => (await current()).prints.length).toBe(1)
  const printed = await current()
  expect(printed.prints[0]).toEqual({ orderRef: 'HAR-0001', reprint: true, customer: null })
  expect(printed).toMatchObject({ pending: 1, outboxOrders: 1, outboxRefunds: [] })

  // Refund the unsynced sale: it queues by uuid with an empty server id.
  await row.getByRole('button', { name: 'Refund Transaksi Ini', exact: true }).click()
  await expect(page.getByText('Transaksi lama: refund seluruhnya')).toBeVisible()
  await page.getByRole('button', { name: 'Lainnya', exact: true }).click()
  await page.getByLabel('Tulis alasan').fill('salah beli')
  await page.getByRole('button', { name: /Konfirmasi Refund/ }).click()
  await expect.poll(async () => (await current()).outboxRefunds.length).toBe(1)
  const queued = await current()
  expect(queued.outboxRefunds[0]).toMatchObject({ orderId: '', reason: 'salah beli' })
  expect(queued.outboxRefunds[0].items).toBeUndefined()
  expect(typeof queued.outboxRefunds[0].saleOrderUuid).toBe('string')
  expect(queued).toMatchObject({ pending: 2, outboxOrders: 1 })

  // A second refund of the same sale is blocked while the first waits.
  await page.getByRole('button', { name: 'Buka Struk di tablet ini', exact: true }).click()
  await expect(panel.getByTestId('local-receipt-row')).toContainText('Refund tersimpan di tablet')
  await expect(panel.getByRole('button', { name: 'Refund Transaksi Ini', exact: true })).toHaveCount(0)
  await expect(panel).toContainText('Refund tersimpan di tablet')
  await panel.getByRole('button', { name: 'Tutup', exact: true }).click()

  // Online: the sale goes first, then the refund; the server refunds the sale once.
  await page.getByRole('button', { name: 'Sambungkan jaringan', exact: true }).click()
  await page.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await expect.poll(async () => (await current()).pending).toBe(0)
  const synced = await current()
  expect(synced.batches).toEqual([['order'], ['refund']])
  expect(synced.serverStatuses).toEqual(['refunded'])
  expect(synced.serverRefunds).toHaveLength(1)
  expect(synced.serverRefunds[0]).toMatchObject({ viaUuid: true, sentOrderId: '' })
  expect(synced.receipts).toEqual([{ number: 'HAR-0001', state: 'synced', refundQueued: false, refunded: true }])

  // The receipt stays on the tablet after the ack, marked as refunded, and cannot be refunded again.
  await page.getByRole('button', { name: 'Buka Struk di tablet ini', exact: true }).click()
  await expect(panel.getByTestId('local-receipt-row')).toHaveCount(1)
  await expect(panel.getByTestId('local-receipt-row')).toContainText('Sudah direfund')
  await expect(panel.getByRole('button', { name: 'Refund Transaksi Ini', exact: true })).toHaveCount(0)
  await evidence(info, { afterReload, printed, queued, synced })
})

test('POS-REFUND-LOCAL-PARTIAL a per-line sale made offline is part-refunded by uuid, blocked meanwhile, synced, then the remainder is refunded', async ({ page }, info) => {
  await page.goto(`${POS}/tests/offline-return/`)
  const current = async () => JSON.parse(await page.getByLabel('Offline return evidence').innerText())
  const panel = page.getByTestId('local-receipts')
  const open = async () => { await page.getByRole('button', { name: 'Buka Struk di tablet ini', exact: true }).click() }

  await page.getByRole('button', { name: 'Jual offline per baris (simulasi)', exact: true }).click()
  await expect.poll(async () => (await current()).pending).toBe(1)
  await page.reload()
  expect(await current()).toMatchObject({ net: false, pending: 1, outboxOrders: 1 })

  // Part refund: one unit of the first line (net 100000 of 3 x 100000).
  await open()
  const row = panel.getByTestId('local-receipt-row')
  await expect(row).toContainText('HAR-0002')
  await row.getByRole('button', { name: 'Refund Transaksi Ini', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Refund Order' })).toBeVisible()
  await page.getByRole('button', { name: /^Tambah Mandalika Oud/ }).click()
  await expect(page.getByTestId('refund-amount')).toHaveText(/Rp\s*100\.000/)
  await page.getByRole('button', { name: 'Rusak/cacat', exact: true }).click()
  await page.getByRole('button', { name: /Konfirmasi Refund/ }).click()
  await expect.poll(async () => (await current()).outboxRefunds.length).toBe(1)
  const queued = await current()
  expect(queued.outboxRefunds[0]).toMatchObject({
    orderId: '', reasonCode: 'rusak_cacat', refundAmount: 100000, items: [{ lineNo: 0, quantity: 1 }],
  })
  expect(typeof queued.outboxRefunds[0].saleOrderUuid).toBe('string')

  // A second refund is blocked while the first waits on this tablet.
  await open()
  await expect(panel.getByTestId('local-receipt-row')).toContainText('Refund tersimpan di tablet')
  await expect(panel.getByRole('button', { name: 'Refund Transaksi Ini', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Tutup', exact: true }).click()

  // Online: sale first, then the part refund.
  await page.getByRole('button', { name: 'Sambungkan jaringan', exact: true }).click()
  await page.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await expect.poll(async () => (await current()).pending).toBe(0)
  const afterPartial = await current()
  expect(afterPartial.batches).toEqual([['order'], ['refund']])
  expect(afterPartial.serverStatuses).toEqual(['partially_refunded'])
  expect(afterPartial.serverRefunds[0]).toMatchObject({ state: 'partial', refundAmount: 100000, items: [{ lineNo: 0, quantity: 1 }] })

  await open()
  await expect(row).toContainText(/Sebagian direfund · sisa Rp\s*250\.000/)
  const again = row.getByRole('button', { name: 'Refund Transaksi Ini', exact: true })
  await expect(again).toBeEnabled()

  // Refund the rest: "Pilih semua" settles the remainder exactly.
  await again.click()
  await page.getByRole('button', { name: 'Pilih semua', exact: true }).click()
  await expect(page.getByTestId('refund-amount')).toHaveText(/Rp\s*250\.000/)
  await page.getByRole('button', { name: 'Rusak/cacat', exact: true }).click()
  await page.getByRole('button', { name: /Konfirmasi Refund/ }).click()
  await expect.poll(async () => (await current()).outboxRefunds.length).toBe(1)
  await page.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await expect.poll(async () => (await current()).pending).toBe(0)
  const final = await current()
  expect(final.serverStatuses).toEqual(['refunded'])
  expect(final.serverRefunds).toHaveLength(2)
  expect(final.serverRefunds[1]).toMatchObject({ state: 'full', refundAmount: 250000 })

  await open()
  await expect(panel.getByTestId('local-receipt-row')).toContainText('Sudah direfund')
  await expect(panel.getByRole('button', { name: 'Refund Transaksi Ini', exact: true })).toHaveCount(0)
  await evidence(info, { queued, afterPartial, final })
})

test('POS-REFUND-GROUP-GUEST a guest sale with a bundle group and a giveaway bag refunds the group together and never the bag', async ({ page }, info) => {
  await page.goto(`${POS}/tests/offline-return/`)
  const current = async () => JSON.parse(await page.getByLabel('Offline return evidence').innerText())
  await page.getByRole('button', { name: 'Jual offline paket + tas (simulasi)', exact: true }).click()
  await expect.poll(async () => (await current()).pending).toBe(1)

  await page.getByRole('button', { name: 'Buka Struk di tablet ini', exact: true }).click()
  const panel = page.getByTestId('local-receipts')
  await panel.getByTestId('local-receipt-row').getByRole('button', { name: 'Refund Transaksi Ini', exact: true }).click()

  // One group box; the bag is listed but has no checkbox.
  await expect(page.getByTestId('refund-group')).toHaveCount(1)
  await expect(page.getByTestId('refund-group').getByRole('checkbox')).toHaveCount(2)
  await expect(page.getByText(/Tas hadiah tidak ikut direfund/)).toBeVisible()
  await expect(page.getByRole('checkbox', { name: /Tas/ })).toHaveCount(0)

  // Picking one member picks both and shows no stepper.
  await page.getByRole('checkbox', { name: /^Pilih Paket Oud/ }).click()
  await expect(page.getByRole('checkbox', { name: /^Pilih Paket Oud/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('checkbox', { name: /^Pilih Paket Musk/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: /^(Tambah|Kurangi) / })).toHaveCount(0)
  await expect(page.getByTestId('refund-amount')).toHaveText(/Rp\s*100\.000/)

  await page.getByRole('button', { name: 'Berubah pikiran', exact: true }).click()
  await page.getByRole('button', { name: /Konfirmasi Refund/ }).click()
  await expect.poll(async () => (await current()).outboxRefunds.length).toBe(1)
  const queued = await current()
  expect(queued.outboxRefunds[0]).toMatchObject({ orderId: '', refundAmount: 100000 })
  expect(queued.outboxRefunds[0].items).toEqual([{ lineNo: 0, quantity: 1 }, { lineNo: 1, quantity: 1 }])

  await page.getByRole('button', { name: 'Sambungkan jaringan', exact: true }).click()
  await page.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await expect.poll(async () => (await current()).pending).toBe(0)
  const synced = await current()
  expect(synced.batches).toEqual([['order'], ['refund']])
  expect(synced.serverStatuses).toEqual(['refunded'])
  await evidence(info, { queued, synced })
})

test('POS-REQUISITION cashier raises, submits with a stable key, tracks and cancels a requisition and never reaches the warehouse actions', async ({ page }, info) => {
  const result = await posRequisition(page as ScenarioPage)
  expect(result).toHaveLength(9)
  await evidence(info, result)
})

for (const [id, title, run, opts] of [
  ['POS-SPLIT-TENDER', 'QRIS with a reference plus cash with change: receipt rows, the tenders on the wire and Split-Payment in the local receipts', posSplitTender, { splitTender: true }],
  ['POS-SPLIT-OFFLINE', 'an offline split sale is queued with its lines and reaches the server with tenders after reconnecting', posSplitOffline, { splitTender: true }],
  ['POS-SPLIT-REFUND', 'a split sale is refunded with the cash payout preselected, then with the QRIS chip', posSplitRefund, { splitTender: true }],
  ['POS-SPLIT-OFF', 'no Bagi pembayaran while the setting is off or absent', posSplitOff, {}],
  ['POS-SPLIT-DRAFT', 'an unfinished split payment is offered back after a reload; a draft whose sale is already queued is dropped silently', posSplitDraft, { splitTender: true }],
] as const) test(`${id} ${title}`, async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p, opts)
  await evidence(info, await run(p))
})
