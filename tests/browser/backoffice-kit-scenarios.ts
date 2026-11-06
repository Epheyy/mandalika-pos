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
  // A reload clears the sequential-focus start point that the sidebar click left behind.
  await page.reload()
  await page.locator('tbody tr').first().waitFor()
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

  // 3. K2b glass shell: the top bar floats over <main> (main starts at the column top, under the bar), is the one
  // blurred layer, and a sticky table header sticks just BELOW it, visible and on top of the rows.
  const bar = (await page.locator('header').first().boundingBox())!
  const mainBox = (await page.locator('main#konten').boundingBox())!
  check(Math.abs(mainBox.y - bar.y) <= 1, `<main> starts under the bar, not below it (bar ${bar.y}, main ${mainBox.y})`)
  const glass = await page.evaluate(() => {
    const css = (el: Element | null) => (el ? getComputedStyle(el) : null)
    const h = css(document.querySelector('header'))
    return {
      bar: h?.backdropFilter ?? '', barWebkit: h?.getPropertyValue('-webkit-backdrop-filter') ?? '',
      sidebar: css(document.querySelector('aside'))?.backdropFilter ?? '', material: document.documentElement.dataset.material,
      ambient: document.documentElement.dataset.ambient, ambientDisplay: css(document.querySelector('.ambient-layer'))?.display ?? '',
      blurred: Array.from(document.querySelectorAll('body *')).filter((e) => { const b = getComputedStyle(e).backdropFilter; return b && b !== 'none' }).map((e) => e.tagName.toLowerCase()),
    }
  })
  check(/blur\(20px\)/.test(glass.bar) && /saturate\(1\.8\)|saturate\(180%\)/.test(glass.bar), `the top bar blurs 20px and saturates 180%, got "${glass.bar}"`)
  check(/blur\(20px\)/.test(glass.barWebkit || glass.bar), 'the -webkit- backdrop-filter is on the bar as well')
  check(glass.sidebar === 'none' || glass.sidebar === '', `the docked sidebar never blurs, got "${glass.sidebar}"`)
  check(glass.blurred.length === 1 && glass.blurred[0] === 'header', `the top bar is the only blurred layer, found ${JSON.stringify(glass.blurred)}`)
  check(glass.material === 'glass' && glass.ambient === 'on' && glass.ambientDisplay === 'block', `material glass and ambient on, got ${JSON.stringify(glass)}`)
  await page.locator('main#konten').evaluate((el) => { el.scrollTop = 700 })
  const th = (await page.locator('thead th').first().boundingBox())!
  const barBottom = bar.y + bar.height
  check(th.y >= barBottom - 1 && th.y <= barBottom + 2, `th sticks just below the bar (th ${th.y}, bar bottom ${barBottom})`)
  const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('thead th') !== null, [th.x + 8, th.y + th.height / 2])
  check(topmost, 'the sticky header is the topmost element at its own position, so it is not under the bar')
  // A row that crosses the bar's own band: it is genuinely under the glass (a row scrolled fully away would not count).
  const underBar = await page.evaluate(([bottom, top]) => Array.from(document.querySelectorAll('tbody tr')).some((r) => { const b = r.getBoundingClientRect(); return b.top < bottom && b.bottom > top }), [barBottom, bar.y] as [number, number])
  check(underBar, 'rows scroll up under the bar (content is under the glass)')
  results.push({ stickyBelowBar: th.y - barBottom, glass })
  // Evidence: the scrolled state with rows under the bar, Mandalika ambient then a neutral brand (ambient only: the
  // skin colours are fixed at build time).
  if (process.env.A34C_RUN_DIR) {
    await captureShot(page, 'k2b-scrolled-mandalika', BO_SHOT_VIEWPORTS)
    const brandBefore = await page.evaluate(() => document.documentElement.dataset.brand ?? 'mandalika')
    await page.evaluate(() => { document.documentElement.dataset.brand = 'flamboyan' })
    await captureShot(page, 'k2b-scrolled-flamboyan', BO_SHOT_VIEWPORTS)
    await page.evaluate((b) => { document.documentElement.dataset.brand = b }, brandBefore)
  }
  await page.locator('main#konten').evaluate((el) => { el.scrollTop = 0 })

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
  // Produk remounts its strip per view (B1's file), so focus is put back by hand before Home.
  await tab('categories').focus()
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
