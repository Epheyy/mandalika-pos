// Pengaturan > Struk: the receipt designer (receipt plan Phase 3). Synthetic API, no real backend.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo, clickTab, navItem } from './fixture'
import { captureShot, type ShotViewport } from './shots'

const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const OUTLETS = [
  { id: '00000000-0000-4000-8f6a-0000000000a1', name: 'MV Outlet Satu', isActive: true, timezone: 'Asia/Jakarta' },
  { id: '00000000-0000-4000-8f6a-0000000000a2', name: 'MV Outlet Dua', isActive: true, timezone: 'Asia/Jakarta' },
  { id: '00000000-0000-4000-8f6a-0000000000a3', name: 'MV Outlet Tiga', isActive: true, timezone: 'Asia/Jakarta' },
]
const SETTINGS = {
  taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none',
  paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'MV Toko', footerText: 'Terima kasih', copies: 1 },
  autoOpenShift: false, allowNegativeStock: true,
}
const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111'
/** 1024 is the narrowest the Backoffice sidebar layout is designed for; 1440 is the desktop default. */
export const RECEIPT_SHOTS: readonly ShotViewport[] = ['bo-1024', 'bo-desktop']

type Json = Record<string, unknown>

/** The block ids in the order the list shows them. */
const blockOrder = (page: ScenarioPage) => page.locator('ul[aria-label="Blok struk"] > li').evaluateAll((els) => els.map((e) => e.getAttribute('data-block-id')))

export const receiptDesignerFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const posts: Json[] = []
  const assigns: Json[] = []
  let stored: Json | null = null

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const method = req.method()
    if (url.pathname.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (url.pathname.endsWith('/outlets')) return route.fulfill({ json: { data: OUTLETS } })
    if (url.pathname.endsWith('/settings/app')) return route.fulfill({ json: { data: SETTINGS } })
    if (url.pathname.endsWith('/receipt-templates/assign') && method === 'PUT') {
      const body = JSON.parse(req.postData() ?? '{}') as Json
      assigns.push(body)
      if (stored) stored = { ...stored, outletIds: body.outletIds }
      return route.fulfill({ status: 204, body: '' })
    }
    if (url.pathname.endsWith('/receipt-templates') && method === 'GET') return route.fulfill({ json: { data: stored ? [stored] : [] } })
    if (url.pathname.endsWith('/receipt-templates') && method === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as Json
      posts.push(body)
      stored = { ...body, id: TEMPLATE_ID, isDefault: false, version: 1, outletIds: [], updatedAt: '2026-11-17T00:00:00Z' }
      return route.fulfill({ status: 201, json: { data: stored } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await openBackoffice(page)
  await navTo(page, 'settings')
  await clickTab(page, 'struk')

  // (a) with no template the designer shows Standar built from the receipt settings; Hapus is off
  await page.getByRole('heading', { name: 'Desain Struk' }).waitFor()
  await page.locator('[data-testid="receipt-paper"]').getByText('MV Toko').waitFor()
  check((await page.getByRole('button', { name: 'Hapus', exact: true }).isDisabled()), 'Hapus is disabled for Standar')
  check((await page.locator('[data-testid="lock-badge"]').count()) === 3, 'three locked rows')
  results.push({ step: 'virtual-standar' })

  // (b) a new template starts from the mockup order; Poin member moves above Daftar barang by keyboard
  await page.getByRole('button', { name: 'Template baru', exact: true }).click()
  await page.getByLabel('Nama template').fill('Promo')
  await page.getByRole('button', { name: 'Buat', exact: true }).click()
  await page.getByRole('button', { name: 'Seret blok Poin member' }).waitFor()
  const before = await blockOrder(page)
  check(before.indexOf('points') > before.indexOf('items'), `points starts below items: ${before.join(',')}`)
  const grip = page.getByRole('button', { name: 'Seret blok Poin member' })
  await grip.focus()
  await page.keyboard.press('Space')
  // dnd-kit's keyboard sensor can swallow the first arrow, so overshoot by one: any slot above Daftar barang is the goal.
  for (let i = 0; i < before.indexOf('points') - before.indexOf('items') + 1; i++) await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Space')
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll('ul[aria-label="Blok struk"] > li')].map((e) => e.getAttribute('data-block-id'))
    return ids.indexOf('points') < ids.indexOf('items')
  })
  results.push({ step: 'reorder', order: await blockOrder(page) })

  // (c) toggle a text block, switch to 80mm
  const thanks = page.getByRole('switch', { name: 'Tampilkan Teks', exact: true })
  check((await thanks.getAttribute('aria-checked')) === 'true', 'the text block starts on')
  await thanks.click()
  check((await thanks.getAttribute('aria-checked')) === 'false', 'the text block switched off')
  await page.getByRole('radio', { name: '80mm', exact: true }).click()
  check((await page.locator('[data-testid="receipt-paper"]').getAttribute('data-cols')) === '48', '80mm gives 48 columns')
  await page.getByRole('button', { name: /^Judul & info outlet/ }).click() // open an editor for the screenshot
  await page.getByTestId('editor-header').waitFor()
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'struk-designer', RECEIPT_SHOTS)
  results.push({ step: 'toggle-and-width' })

  // (d) Simpan: the POST carries the design and none of the Standar-only fields
  await page.getByRole('button', { name: 'Simpan', exact: true }).click()
  await page.getByText('Template tersimpan').waitFor()
  check(posts.length === 1, `one POST, got ${posts.length}`)
  const body = posts[0]!
  for (const k of ['compat', 'spaceAfter', 'spaceBefore', 'showChange']) check(!JSON.stringify(body).includes(k), `POST has no ${k}`)
  check(body.name === 'Promo' && body.paperWidth === 80 && !('isDefault' in body) && !('version' in body), `POST body ${JSON.stringify(body).slice(0, 120)}`)
  const ids = (body.blocks as Array<{ id: string; enabled: boolean }>)
  check(ids.findIndex((b) => b.id === 'points') < ids.findIndex((b) => b.id === 'items'), 'POST keeps the reorder')
  check(ids.find((b) => b.id === 'thanks')?.enabled === false, 'POST keeps the toggle')
  results.push({ step: 'save', body })

  // (e) assign two outlets; a reload shows Dipakai di 2 outlet
  await page.getByRole('button', { name: 'Dipakai di 0 outlet', exact: true }).click()
  const dialog = page.locator('[role="dialog"]')
  await dialog.getByLabel('MV Outlet Satu').check()
  await dialog.getByLabel('MV Outlet Dua').check()
  await dialog.getByRole('button', { name: 'Simpan', exact: true }).click()
  await page.getByRole('button', { name: 'Dipakai di 2 outlet', exact: true }).waitFor()
  check(assigns.length === 1 && assigns[0]!.templateId === TEMPLATE_ID && (assigns[0]!.outletIds as string[]).length === 2, `assign body ${JSON.stringify(assigns[0])}`)
  await page.reload()
  await navItem(page, 'settings').waitFor()
  await page.getByRole('heading', { name: 'Desain Struk' }).waitFor()
  await page.getByLabel('Template', { exact: true }).selectOption({ label: 'Promo' })
  await page.getByRole('button', { name: 'Dipakai di 2 outlet', exact: true }).waitFor()
  results.push({ step: 'assign-and-reload', assign: assigns[0] })
  return results
}
