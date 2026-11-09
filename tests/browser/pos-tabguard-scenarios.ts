// F22/W01 (QA R10): a waiting second POS tab takes over BY ITSELF when the first one goes away, in a real browser,
// with the first tab's open-cart draft. Three ways the owner goes away: it closes, it navigates elsewhere, it
// reloads. Chromium only: the Web Locks owner is released by the browser when the document is torn down.
import type { Page } from '@playwright/test'
import type { ScenarioPage } from './fixture'

const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
const OUTLET = '00000000-0000-4000-8300-000000000090'
const DRAFT_KEY = `mandalika.pos.openCart.${OUTLET}`
const BLOCKED_TEXT = 'POS sudah terbuka di tab lain'
const POS_URL = 'http://127.0.0.1:5183/'
/** The queued tab must reach the cashier within this long after the owner is gone. The hand-over itself takes ~0.2 s
 *  locally; the bound covers the whole boot (auth, pull, restore) on a slow CI runner. */
const TAKEOVER_BOUND_MS = 15000
const OBSERVE_MS = 700 // observed after the notice is up, i.e. at least ~1.5 s after the tab opened

interface ApiCall { method: string; path: string }

// A second tab needs the same synthetic API as the first (Playwright routes are per page).
type Fixture = ScenarioPage['__a24']
async function serveSyntheticApi(tab: Page, a24: Fixture, calls: ApiCall[]) {
  const user = { id: '00000000-0000-4000-8300-000000000091', displayName: 'Synthetic Cashier', role: 'admin', outletId: OUTLET, permissions: ['create_order', 'manage_promotions'] }
  await tab.route('http://127.0.0.1:59999/api/v1/**', (route) => {
    const req = route.request()
    const path = req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    calls.push({ method: req.method(), path })
    if (path.endsWith('/sync/batch')) return route.fulfill({ status: 503, json: { error: 'Synthetic retain-only transport' } })
    let data: unknown = []
    if (path.includes('/auth/')) data = { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user }
    else if (path.endsWith('/sync/pull')) data = { ...a24.snapshot, version: a24.version }
    else if (path.endsWith('/sync/version')) data = { version: a24.version }
    else if (path.endsWith('/shifts/current')) data = { id: '00000000-0000-4000-8300-000000000080', status: 'open', startingCash: 1100000, cashierId: user.id, outletId: OUTLET, openedAt: new Date().toISOString() }
    else if (path.endsWith('/outlets')) data = [{ id: OUTLET, name: 'Synthetic Outlet', isActive: true }]
    else if (path.endsWith('/settings')) data = a24.snapshot.appSettings
    else if (path.endsWith('/customers')) data = [a24.customer]
    return route.fulfill({ status: 200, json: { data, meta: { total: Array.isArray(data) ? data.length : 1, page: 1, limit: 50 } } })
  })
}

/** Count every Storage write the tab makes, from its first script on. */
async function countStorageWrites(tab: Page) {
  await tab.addInitScript(() => {
    const w = window as unknown as { __writes: string[] }
    w.__writes = []
    for (const m of ['setItem', 'removeItem', 'clear'] as const) {
      const orig = Storage.prototype[m] as (...a: unknown[]) => unknown
      ;(Storage.prototype as unknown as Record<string, unknown>)[m] = function (this: Storage, ...a: unknown[]) {
        w.__writes.push(`${m}:${String(a[0] ?? '')}`)
        return orig.apply(this, a)
      }
    }
  })
}
const storageWrites = (tab: Page) => tab.evaluate(() => (window as unknown as { __writes: string[] }).__writes)
const posKeys = (tab: Page) => tab.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mandalika.')).sort())

/** The tab shows the cashier with the draft line restored. */
async function expectCashierWithDraft(tab: Page, what: string, guarded = true) {
  const started = Date.now()
  try {
    await tab.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor({ timeout: TAKEOVER_BOUND_MS })
  } catch (err) {
    throw Error(`${what}: did not reach the cashier with the draft within ${TAKEOVER_BOUND_MS} ms: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
  }
  assert((await tab.getByText(BLOCKED_TEXT).count()) === 0, `${what}: the other-tab notice is gone`)
  if (guarded) assert((await tab.getByTestId('tab-guard-unavailable').count()) === 0, `${what}: a guarded tab shows no no-guard warning`)
  return Date.now() - started
}

/** A freshly started owner is still writing (sync, device keys): wait until its storage keys stop changing. */
async function settle(tab: Page) {
  let last = '', steady = 0
  for (let i = 0; i < 40 && steady < 4; i++) {
    const now = JSON.stringify(await posKeys(tab))
    steady = now === last ? steady + 1 : 0
    last = now
    await tab.waitForTimeout(150)
  }
}

/** Open a second tab and prove it waits quietly: the notice, no sale controls, no API call, no storage write. */
async function openQueuedTab(first: Page, a24: Fixture) {
  const tab = await first.context().newPage()
  const calls: ApiCall[] = []
  await countStorageWrites(tab)
  await serveSyntheticApi(tab, a24, calls)
  await settle(first)
  await tab.goto(POS_URL)
  await tab.getByText(BLOCKED_TEXT).waitFor()
  await tab.waitForTimeout(OBSERVE_MS)
  const writes = await storageWrites(tab)
  assert(writes.length === 0, 'the waiting tab wrote to storage: ' + JSON.stringify(writes))
  assert(calls.length === 0, 'the waiting tab called the API (sync/pull/writes): ' + JSON.stringify(calls))
  assert((await tab.getByRole('button', { name: /Synthetic Scent/ }).count()) === 0, 'the waiting tab shows no cashier controls')
  return { tab, calls }
}

// POS-TWO-TABS-TAKEOVER
export const posTabTakeover = async (page: ScenarioPage) => {
  const out: Record<string, unknown>[] = []
  const a24 = page.__a24
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  await page.waitForFunction((k) => !!localStorage.getItem(k), DRAFT_KEY)
  const draft = await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)

  // 1. The owner closes.
  const one = await openQueuedTab(page, a24)
  await page.close()
  const closeMs = await expectCashierWithDraft(one.tab, 'owner closed')
  assert((await one.tab.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)) !== null, 'the draft survives the takeover')
  out.push({ ownerCloses: 'queued tab reached the cashier with the draft, no reload', ms: closeMs })

  // 2. The owner (now tab 1) navigates to another URL (what a tester does by typing an address).
  const two = await openQueuedTab(one.tab, a24)
  await one.tab.goto('about:blank')
  const navMs = await expectCashierWithDraft(two.tab, 'owner navigated away')
  out.push({ ownerNavigates: 'queued tab reached the cashier with the draft, no reload', ms: navMs })
  await one.tab.close()

  // 3. The owner (now tab 2) reloads while a third tab is queued: the queued tab was first in line, so it wins
  // and the reloaded page is the one that waits.
  const three = await openQueuedTab(two.tab, a24)
  const callsBefore = two.calls.length
  await two.tab.reload()
  const reloadMs = await expectCashierWithDraft(three.tab, 'owner reloaded')
  await two.tab.getByText(BLOCKED_TEXT).waitFor()
  await two.tab.waitForTimeout(OBSERVE_MS)
  assert((await storageWrites(two.tab)).length === 0, 'the reloaded page wrote to storage while it waited')
  assert(two.calls.length === callsBefore, 'the reloaded page called the API while it waited')
  assert((await two.tab.getByRole('button', { name: /Synthetic Scent/ }).count()) === 0, 'the reloaded page waits, it does not run the cashier')
  out.push({ ownerReloads: 'the queued tab owns the POS afterwards; the reloaded page shows the notice', ms: reloadMs })

  // 4. Closing the new owner hands the POS back to the waiting reloaded page.
  await three.tab.close()
  await expectCashierWithDraft(two.tab, 'queued reloaded page after the owner closed')
  out.push({ chain: 'the waiting reloaded page starts once the new owner closes' })
  await two.tab.close()

  // 5. No Web Locks in this browser: the guard fails open, and the app says so in a visible, persistent notice.
  const bare = await page.context().newPage()
  await bare.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }))
  await serveSyntheticApi(bare, a24, [])
  await bare.goto(POS_URL)
  await expectCashierWithDraft(bare, 'no Web Locks', false)
  const notice = bare.getByTestId('tab-guard-unavailable')
  assert((await notice.innerText()).startsWith('Perlindungan satu tab tidak aktif'), 'the no-guard warning is visible')
  await bare.waitForTimeout(OBSERVE_MS)
  assert(await notice.isVisible(), 'the no-guard warning stays')
  out.push({ noGuard: 'without Web Locks the cashier runs and the warning stays visible' })
  await bare.close()
  return out
}
