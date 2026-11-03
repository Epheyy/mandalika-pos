// Fase D3b: Kirim and Batalkan on a transfer ask first, and a confirm calls the write once with one Idempotency-Key
// (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { openBackoffice } from './fixture'

const OUTLET = '00000000-0000-4000-8f6b-0000000000a1'
const TRANSFER_ID = '00000000-0000-4000-8f6b-0000000000d1'
const NUMBER = 'TRF-CONF-1'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

type Status = 'draft' | 'in_transit' | 'cancelled'
interface PostCall { action: 'send' | 'cancel'; key: string | null }

const transfer = (status: Status) => ({
  id: TRANSFER_ID, transferNo: NUMBER, status, source: { kind: 'warehouse', id: 'w1', name: 'Gudang Pusat' },
  dest: { kind: 'outlet', id: OUTLET, name: 'MV Outlet' }, createdAt: '2026-01-03T05:00:00Z',
  items: [
    { productId: 'p1', productName: 'Parfum A', variantSize: '30ml', sentQty: 4 },
    { productId: 'p2', productName: 'Parfum B', variantSize: '50ml', sentQty: 3 },
  ],
})
const settings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none', paymentMethods: [{ id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true }],
  receipt: { headerText: 'Hai', footerText: 'Terima kasih' }, autoOpenShift: false, allowNegativeStock: true, recipesEnabled: false,
  inventoryApprovalRequired: false, splitTenderEnabled: true, documents: { brandName: 'Mandalika' },
}

/** Stateful transfer API: the first `failSends` sends are refused, a cancel answers after `cancelDelayMs`, `setStatus` plays another user. */
async function mockApi(page: ScenarioPage, opts: { failSends?: number; cancelDelayMs?: number } = {}) {
  const calls: PostCall[] = []
  let status: Status = 'draft'
  let sendAttempts = 0
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/settings/app')) return route.fulfill({ json: { data: settings } })
    if (path.endsWith(`/transfers/${TRANSFER_ID}`) && request.method() === 'GET') return route.fulfill({ json: { data: transfer(status) } })
    const write = /\/transfers\/[^/]+\/(send|cancel)$/.exec(path)
    if (write && request.method() === 'POST') {
      const action = write[1] as 'send' | 'cancel'
      calls.push({ action, key: request.headers()['idempotency-key'] ?? null })
      if (action === 'send') {
        sendAttempts += 1
        if (sendAttempts <= (opts.failSends ?? 0)) return route.fulfill({ status: 500, json: { error: 'Gudang tidak merespons (uji)' } })
        status = 'in_transit'
      } else {
        if (opts.cancelDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.cancelDelayMs))
        status = 'cancelled'
      }
      return route.fulfill({ json: { data: { ok: true } } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  return { calls, setStatus: (next: Status) => { status = next } }
}

export const transferConfirmFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const { calls, setStatus } = await mockApi(page, { failSends: 2, cancelDelayMs: 400 })
  await openBackoffice(page)
  await page.evaluate((h) => { location.hash = h }, `#/inventori/transfer/${TRANSFER_ID}`)
  await page.reload()
  await page.getByRole('heading', { name: NUMBER }).waitFor()

  const sendDialog = page.getByRole('alertdialog', { name: `Kirim transfer ${NUMBER}?` })
  const badge = (text: string) => page.getByText(text, { exact: true })

  // (a) Kirim asks first and names what happens to the stock; nothing is sent yet
  await page.getByRole('button', { name: 'Kirim', exact: true }).click()
  await sendDialog.waitFor()
  check((await sendDialog.textContent())?.includes('Stok 7 unit akan keluar dari Gudang Pusat sekarang.') === true, 'the dialog states the unit count and the source')
  check(calls.length === 0, 'asking sends nothing')
  results.push({ step: 'kirim-asks' })

  // (b) Batal leaves the draft untouched
  await sendDialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await sendDialog.waitFor({ state: 'detached' })
  check(calls.length === 0, 'Batal sends nothing')
  await badge('Draf').first().waitFor()
  check(await page.getByRole('button', { name: 'Kirim', exact: true }).isVisible(), 'the draft still offers Kirim')
  results.push({ step: 'batal-leaves-draft' })

  // (c) a refused send keeps the dialog open with the reason; the retry reuses the same key; closing drops it and a reopen gets a new one
  await page.getByRole('button', { name: 'Kirim', exact: true }).click()
  await sendDialog.waitFor()
  const confirmSend = sendDialog.getByRole('button', { name: 'Kirim transfer', exact: true })
  await confirmSend.click()
  await sendDialog.getByRole('alert').waitFor()
  check((await sendDialog.getByRole('alert').textContent())?.includes('Gudang tidak merespons') === true, 'the refusal shows inside the dialog')
  await confirmSend.click()
  await page.waitForFunction(() => document.querySelectorAll('[role="alertdialog"]').length === 1)
  await sendDialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await sendDialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Kirim', exact: true }).click()
  await sendDialog.waitFor()
  await confirmSend.click()
  await sendDialog.waitFor({ state: 'detached' })
  await badge('Dikirim').first().waitFor()
  check(calls.length === 3 && calls.every((c) => c.action === 'send'), `three send attempts, got ${JSON.stringify(calls)}`)
  check(!!calls[0].key && calls[0].key === calls[1].key, 'the retry inside the dialog carries the same Idempotency-Key')
  check(!!calls[2].key && calls[2].key !== calls[0].key, 'a reopened dialog gets a new Idempotency-Key')
  results.push({ step: 'refused-retry-same-key-reopen-new-key' })

  // (d) the transfer changed under the open dialog (another user cancelled it): the confirm refuses and writes nothing
  const cancelDialog = page.getByRole('alertdialog', { name: `Batalkan transfer ${NUMBER}?` })
  await page.getByRole('button', { name: 'Batalkan', exact: true }).click()
  await cancelDialog.waitFor()
  setStatus('cancelled')
  await cancelDialog.getByRole('button', { name: 'Batalkan transfer', exact: true }).click()
  await cancelDialog.getByRole('alert').waitFor()
  check((await cancelDialog.getByRole('alert').textContent())?.includes('Transfer berubah') === true, 'a changed transfer is refused inside the dialog')
  check(calls.filter((c) => c.action === 'cancel').length === 0, 'a changed transfer sends no cancel')
  await cancelDialog.getByRole('button', { name: 'Kembali', exact: true }).click()
  await cancelDialog.waitFor({ state: 'detached' })
  results.push({ step: 'changed-under-dialog-refused' })

  // (e) confirming Batalkan calls the write exactly once, even on a double click, with a key of its own
  setStatus('in_transit')
  await page.reload()
  await page.getByRole('heading', { name: NUMBER }).waitFor()
  await page.getByRole('button', { name: 'Batalkan', exact: true }).click()
  await cancelDialog.waitFor()
  check((await cancelDialog.textContent())?.includes('Stok 7 unit dikembalikan ke Gudang Pusat sekarang.') === true, 'the cancel dialog says the stock returns')
  await cancelDialog.getByRole('button', { name: 'Batalkan transfer', exact: true }).dblclick()
  await cancelDialog.waitFor({ state: 'detached' })
  await badge('Dibatalkan').first().waitFor()
  const cancels = calls.filter((c) => c.action === 'cancel')
  check(cancels.length === 1, `one cancel call, got ${cancels.length}`)
  check(!!cancels[0].key && !calls.some((c) => c.action === 'send' && c.key === cancels[0].key), 'the cancel has a key of its own')
  results.push({ step: 'confirm-once-own-key' })

  return results
}
