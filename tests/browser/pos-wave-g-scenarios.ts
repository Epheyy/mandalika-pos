// QA wave G (2026-11-08): F19 stock-pending honesty, F22/W01 single active tab.
import type { ScenarioPage } from './fixture'

const assert = (v: unknown, m: string) => { if (!v) throw Error(m) }
const OUTLET = '00000000-0000-4000-8300-000000000090'
const DRAFT_KEY = `mandalika.pos.openCart.${OUTLET}`
const BLOCKED_TEXT = 'POS sudah terbuka di tab lain'

// POS-STOCK-PENDING: another tablet sold (stock counter moves, content version does not) while the cashier has a
// cart open, so the throttled/deferred stock pull cannot run. After the hold-off the chip stops claiming
// "Tersinkron" and says the stock waits; emptying the cart lets exactly one pull through and the chip is quiet again.
export const posStockPending = async (page: ScenarioPage) => {
  const pulls = () => page.__a24.calls.filter((c: any) => c.path.endsWith('/sync/pull')).length
  const body = () => page.locator('body').innerText()
  page.__a24.stockSeq = 10 // from here the fixture server sends a counter, so the boot pull binds the snapshot
  await page.clock.install({ time: Date.now() })
  await page.reload()
  await page.getByRole('button', { name: /Synthetic Scent/ }).first().waitFor()
  const advance = async (seconds: number, until: () => Promise<boolean> | boolean = () => false) => {
    for (let i = 0; i < seconds; i++) {
      if (await until()) return true
      await page.clock.runFor(1000)
      await page.waitForTimeout(40)
    }
    return until()
  }
  assert((await body()).includes('Tersinkron'), 'quiet and synced to start with')

  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  const n0 = pulls()
  page.__a24.products[0].variants[0].stock -= 3
  page.__a24.stockSeq = 11
  // Inside the 60 s hold-off nothing changes on screen (short lags stay quiet).
  await advance(30)
  assert((await body()).includes('Tersinkron'), 'a short lag stays quiet')
  assert(await advance(120, async () => (await body()).includes('Stok menunggu diperbarui')), 'the chip says the stock waits')
  assert(!(await body()).includes('Tersinkron'), 'it no longer claims everything is fresh')
  assert(pulls() === n0, 'no pull while the cart holds an item')

  await page.getByRole('button', { name: 'Kosongkan', exact: true }).click()
  await page.getByRole('dialog').filter({ hasText: 'Kosongkan keranjang?' }).getByRole('button', { name: 'Kosongkan', exact: true }).click()
  assert(await advance(120, () => pulls() === n0 + 1), 'exactly one pull once the cart is empty')
  assert(await advance(30, async () => { const t = await body(); return t.includes('Tersinkron') && !t.includes('Stok menunggu') }), 'the chip is quiet again')
  await advance(60)
  assert(pulls() === n0 + 1, 'no further pulls')
  return [{ step: 'stock waits behind an open cart', pulls: pulls() - n0 }]
}

// POS-TWO-TABS: a second tab on the same browser profile never starts the app, never writes storage, leaves the
// first tab's cart draft alone, and starts by itself once the first tab is gone.
export const posTwoTabs = async (page: ScenarioPage) => {
  await page.getByRole('searchbox').fill('SYN-M')
  await page.getByRole('searchbox').press('Enter')
  await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).waitFor()
  await page.waitForFunction((k) => !!localStorage.getItem(k), DRAFT_KEY)
  const draftBefore = await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)

  const tabB = await page.context().newPage()
  // Count every storage write tab B makes, from the first script on.
  await tabB.addInitScript(() => {
    const w = window as unknown as { __writes: string[] }
    w.__writes = []
    const proto = Storage.prototype
    for (const m of ['setItem', 'removeItem', 'clear'] as const) {
      const orig = proto[m] as (...a: unknown[]) => unknown
      ;(proto as unknown as Record<string, unknown>)[m] = function (this: Storage, ...a: unknown[]) {
        w.__writes.push(`${m}:${String(a[0] ?? '')}`)
        return orig.apply(this, a)
      }
    }
  })
  // Tab B's API answers 503: after the takeover it only has to start, not to sell.
  await tabB.route('http://127.0.0.1:59999/api/v1/**', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic tab B' } }))
  await tabB.goto('http://127.0.0.1:5183/')
  await tabB.getByText(BLOCKED_TEXT).waitFor()
  await tabB.waitForTimeout(500)
  const writes = await tabB.evaluate(() => (window as unknown as { __writes: string[] }).__writes)
  assert(writes.length === 0, 'tab B wrote to storage: ' + JSON.stringify(writes))
  assert((await tabB.getByRole('button', { name: /Synthetic Scent/ }).count()) === 0, 'tab B shows no sale controls')
  assert((await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)) === draftBefore, 'tab A draft untouched')
  assert((await page.getByRole('button', { name: 'Ubah Synthetic Scent M', exact: true }).count()) === 1, 'tab A cart intact')

  await page.close() // tab A goes away: its lock is released
  await tabB.getByText(BLOCKED_TEXT).waitFor({ state: 'detached' })
  assert((await tabB.evaluate(() => document.getElementById('root')?.childElementCount ?? 0)) > 0, 'tab B started by itself')
  await tabB.close()
  return [{ blocked: 'second tab shows the notice, zero storage writes', takeover: 'starts when the first tab closes' }]
}
