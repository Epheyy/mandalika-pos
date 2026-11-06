// Kaca K2: the backoffice kit and shell, measured in a real browser (jsdom cannot lay anything out). Produk is the
// subject because it is a DataTable page with a tab strip. Synthetic API, no real backend.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo } from './fixture'
import { BO_SHOT_VIEWPORTS, captureShot } from './shots'

const OUTLET = '00000000-0000-4000-8f6d-0000000000e1'
const TOTAL = 60
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

const EMPTY_SUMMARY = {
  from: null, to: null, outletId: null, totalSales: 0, totalOrders: 0, grossSales: 0, grossOrders: 0, totalRefunds: 0, refundedOrders: 0,
  netSales: 0, avgOrderValue: 0, byPaymentMethod: {}, grossByPaymentMethod: {}, refundsByPaymentMethod: {}, topProducts: [], dailySales: [],
}

const products = Array.from({ length: TOTAL }, (_, i) => ({
  id: `00000000-0000-4000-8f6d-a${String(i).padStart(11, '0')}`, name: `Parfum ${String(i).padStart(3, '0')}`, brand: 'Mandalika',
  categoryId: null, isActive: true, isFeatured: false, sellable: true, createdAt: '2026-01-03T05:00:00Z',
  variants: [{ id: `00000000-0000-4000-8f6d-b${String(i).padStart(11, '0')}`, size: '30 ml', price: 150000, stock: 20, sku: `SKU-${i}`, barcode: `BC-${i}` }],
}))

async function mockApi(page: ScenarioPage) {
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    const json = (data: unknown) => route.fulfill({ json: data })
    if (path.startsWith('/auth/')) return json({ data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } })
    if (path === '/outlets') return json({ data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] })
    if (path === '/settings/app') return json({ data: { recipesEnabled: false, paymentMethods: [] } })
    if (path === '/categories') return json({ data: [] })
    if (path === '/bundles') return json({ data: [] })
    if (path === '/reports/summary') return json({ data: EMPTY_SUMMARY })
    if (path === '/products') return json({ data: products, meta: { total: TOTAL, page: 1, limit: 50 } })
    return json({ data: [], meta: { total: 0, page: 1, limit: 50 } })
  })
}

/** Scrollable boxes on the page: overflow auto/scroll that actually has more to show, outside the sidebar's own nav. */
const scrollBoxes = (page: ScenarioPage) =>
  page.evaluate(() => {
    const found: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest('aside')) continue
      const s = getComputedStyle(el)
      const scrolls = (v: string) => v === 'auto' || v === 'scroll'
      if (scrolls(s.overflowY) && el.scrollHeight > el.clientHeight + 1) found.push(el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''))
      if (scrolls(s.overflowX) && el.scrollWidth > el.clientWidth + 1) found.push(`${el.tagName.toLowerCase()}(x)`)
    }
    return found
  })

export const kitShellFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  await mockApi(page)
  await openBackoffice(page)
  await navTo(page, 'products')
  await page.locator('tbody tr').first().waitFor()
  await page.getByText('Parfum 000').first().waitFor()

  // 1. The skip link is the first stop, shows on focus, and lands on <main> without touching the router's hash.
  const hashBefore = await page.evaluate(() => location.hash)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Tab')
  const first = await page.evaluate(() => document.activeElement?.textContent ?? '')
  check(first === 'Lewati ke konten', `the first Tab stop is the skip link, got "${first}"`)
  check(await page.getByRole('button', { name: 'Lewati ke konten' }).isVisible(), 'the skip link is visible while focused')
  await page.keyboard.press('Enter')
  const landed = await page.evaluate(() => document.activeElement?.id ?? '')
  check(landed === 'konten', `Enter moves focus to main#konten, got "${landed}"`)
  check((await page.evaluate(() => location.hash)) === hashBefore, 'the skip link leaves the hash alone')
  results.push({ skipLink: 'ok' })

  // 2. One scroll area on the page: <main>. No inner table box, whatever the table holds.
  const boxes = await scrollBoxes(page)
  check(boxes.length === 1 && boxes[0] === 'main#konten', `exactly one scroll area, <main>; found ${JSON.stringify(boxes)}`)
  results.push({ scrollAreas: boxes })

  // 3. The sticky header stays in view while <main> scrolls.
  const mainBox = (await page.locator('main#konten').boundingBox())!
  await page.locator('main#konten').evaluate((el) => { el.scrollTop = 700 })
  const th = (await page.locator('thead th').first().boundingBox())!
  check(Math.abs(th.y - mainBox.y) <= 2, `th sticks to the top of <main> (th ${th.y}, main ${mainBox.y})`)
  await page.locator('main#konten').evaluate((el) => { el.scrollTop = 0 })
  results.push({ stickyTop: th.y - mainBox.y })

  // 4. Tabs: role=tab + aria-selected; arrows only move focus (manual activation); Enter selects.
  const tab = (key: string) => page.locator(`[data-tab-key="${key}"]`)
  check((await tab('products').getAttribute('role')) === 'tab', 'a Produk tab has role=tab')
  check((await tab('products').getAttribute('aria-selected')) === 'true', 'Produk is selected')
  check((await tab('categories').getAttribute('tabindex')) === '-1', 'an unselected tab is out of the tab order')
  await tab('products').focus()
  await page.keyboard.press('ArrowRight')
  check((await page.evaluate(() => document.activeElement?.getAttribute('data-tab-key'))) === 'categories', 'ArrowRight moves focus to the next tab')
  check((await tab('products').getAttribute('aria-selected')) === 'true', 'moving focus does not select')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-tab-key="categories"]')?.getAttribute('aria-selected') === 'true')
  await page.keyboard.press('Home')
  check((await page.evaluate(() => document.activeElement?.getAttribute('data-tab-key'))) === 'products', 'Home moves focus to the first tab')
  results.push({ tabs: 'ok' })
  await tab('products').click()
  await page.getByText('Parfum 000').first().waitFor()

  // 5. A narrow screen scrolls the table inside its card, with no sticky header; nothing else on the page scrolls sideways.
  await page.setViewportSize({ width: 375, height: 812 })
  await page.waitForFunction(() => document.querySelector('thead th') && getComputedStyle(document.querySelector('thead th')!).position !== 'sticky')
  const narrow = await scrollBoxes(page)
  check(narrow.some((b) => b === 'div(x)'), `at 375 px the table wrapper scrolls sideways; found ${JSON.stringify(narrow)}`)
  check(!narrow.includes('main#konten(x)'), '<main> does not scroll sideways')
  results.push({ narrow })

  // 6. Evidence for the reviewer: Produk at 1440, 768 and 375.
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'k2-produk', BO_SHOT_VIEWPORTS)
  return results
}
