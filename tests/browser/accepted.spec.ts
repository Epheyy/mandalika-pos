import { test, expect, evidence, POS, BO, type ScenarioPage } from './fixture'
import { setupPos, qualifyPos, posBoundaries, physicalQueue, guestSales, addCustomer, posRecap } from './pos-scenarios'
import { setupBackoffice, backofficeChecks, transactionsChecks, qualifyBackoffice, reportsRaces } from './backoffice-scenarios'
import { reviewResolveFlow } from './backoffice-review-scenarios'
import { csvImportFlow } from './backoffice-import-scenarios'

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
  await page.getByRole('button', { name: 'Perlu ditinjau (2)', exact: true }).click()
  const outcomes: object[] = []
  for (const scenario of ['share success', 'share success', 'cancel', 'share failure', 'clipboard failure']) {
    await page.getByLabel('Diagnostic outcome').selectOption(scenario)
    await page.getByRole('button', { name: 'Bagikan log diagnostik', exact: true }).click()
    await expect.poll(async () => JSON.parse(await page.locator('pre').innerText()).exports).toBe(outcomes.length + 1)
    const current = JSON.parse(await page.locator('pre').innerText())
    expect(current).toMatchObject({ retained: 2, unchanged: true, reconstructed: true, failed: 2 })
    await expect(page.getByRole('button', { name: 'Perlu ditinjau (2)', exact: true })).toBeVisible()
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
  await page.getByRole('button', { name: 'Perlu ditinjau (1)', exact: true }).click()
  await page.getByRole('button', { name: 'Bagikan log diagnostik', exact: true }).click()
  await expect.poll(async () => (await current()).exports).toBe(1)
  expect((await current()).retained).toEqual(parked.retained)
  await page.getByRole('button', { name: 'Reconstruct from same storage' }).click()
  expect((await current()).retained).toEqual(parked.retained)
  await page.getByRole('button', { name: 'Restore synthetic permission' }).click()
  await page.getByRole('button', { name: 'Perlu ditinjau (1)', exact: true }).click()
  await page.getByRole('button', { name: 'Coba lagi', exact: true }).click()
  await expect.poll(async () => (await current()).retained.length).toBe(0)
  const final = await current()
  expect(final.simulatedMutationCalls).toBe(1)
  expect(final.deliveries.at(-1)[0].idempotencyKey).toBe(parked.retained[0].idempotencyKey)
  await evidence(info, { original, parked, final })
})
