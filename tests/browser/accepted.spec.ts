import { test, expect, evidence, POS, BO, type ScenarioPage } from './fixture'
import { setupPos, qualifyPos, posBoundaries, physicalQueue, guestSales, addCustomer, posRecap, posAutoPull, posStockDrift } from './pos-scenarios'
import { setupBackoffice, backofficeChecks, transactionsChecks, qualifyBackoffice, reportsRaces } from './backoffice-scenarios'
import { reviewResolveFlow } from './backoffice-review-scenarios'
import { csvImportFlow } from './backoffice-import-scenarios'
import { stockCardFlow } from './backoffice-stockcard-scenarios'
import { posRequisition } from './pos-requisition-scenarios'

test('BO-SEMANTIC authoring rejects overlap and preserves valid edit duplicate toggle', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  await p.goto(BO)
  await p.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('mandalika.backoffice.refresh', 'SYNTHETIC-NON-TOKEN')
    localStorage.setItem('mandalika.backoffice.loginDate', new Date().toLocaleDateString('sv-SE'))
  })
  await p.reload()
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

test('POS-RECAP all pages cached and actual panel remount keeps complete snapshot', async ({ page }, info) => {
  const p = page as ScenarioPage
  await setupPos(p)
  await p.getByRole('button', { name: 'Menu', exact: true }).click()
  await evidence(info, await posRecap(p))
})

test('BO-REVIEW-RESOLVE head office resolves a parked tablet item and the badge clears', async ({ page }, info) => {
  const result = await reviewResolveFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-CSV-IMPORT preview errors block apply, a clean preview applies with an idempotency key', async ({ page }, info) => {
  const result = await csvImportFlow(page as ScenarioPage)
  expect(result).toHaveLength(4)
  await evidence(info, result)
})

test('BO-STOCK-CARD summary row opens the kartu stok, rows page, Hadiah chip filters, CSV downloads', async ({ page }, info) => {
  const result = await stockCardFlow(page as ScenarioPage)
  expect(result).toHaveLength(9)
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
  await page.getByLabel('Alasan Refund *').fill('salah beli')
  await page.getByRole('button', { name: 'Konfirmasi Refund', exact: true }).click()
  await expect.poll(async () => (await current()).outboxRefunds.length).toBe(1)
  const queued = await current()
  expect(queued.outboxRefunds[0]).toMatchObject({ orderId: '', reason: 'salah beli' })
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


test('POS-REQUISITION cashier raises, submits with a stable key, tracks and cancels a requisition and never reaches the warehouse actions', async ({ page }, info) => {
  const result = await posRequisition(page as ScenarioPage)
  expect(result).toHaveLength(9)
  await evidence(info, result)
})
