// C6c backoffice split payment: Transaksi list/detail/filter/CSV, the admin refund payout chips, and the
// "Bayar terpisah" setting (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo, openTab, clickTab } from './fixture'

const OUTLET = '00000000-0000-4000-8f6a-0000000000a1'
const uuid = (n: number) => `00000000-0000-4000-8f6a-${String(n).padStart(12, '0')}`
const NOW = '2026-01-03T05:00:00Z'
const user = { id: 'synthetic-admin', displayName: 'MV Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const METHODS = [
  { id: 'tunai', label: 'Tunai', isEnabled: true, isCash: true },
  { id: 'qris', label: 'QRIS', isEnabled: true, isCash: false },
  { id: 'card', label: 'Kartu', isEnabled: true, isCash: false },
]
const EMPTY_SUMMARY = {
  from: null, to: null, outletId: null, totalSales: 0, totalOrders: 0, grossSales: 0, grossOrders: 0, totalRefunds: 0, refundedOrders: 0,
  netSales: 0, avgOrderValue: 0, byPaymentMethod: {}, grossByPaymentMethod: {}, refundsByPaymentMethod: {}, topProducts: [], dailySales: [],
}

const line = (lineNo: number, name: string, qty: number, net: number, over: Record<string, unknown> = {}) => ({
  id: uuid(800 + lineNo), lineNo, productId: uuid(900 + lineNo), productName: name, variantSize: '', quantity: qty, unitPrice: net / qty, price: net / qty,
  subtotal: net, netAmount: net, refundedQty: 0, ...over,
})
const tender = (seq: number, method: string, amount: number, over: Record<string, unknown> = {}) =>
  ({ seq, method, amount, tendered: amount, change: 0, reference: null, synthetic: false, ...over })

// A split sale: QRIS 751.000 (ref 8812345) + cash 500.000 handed over as 600.000; one cash refund of half of line 0.
const splitOrder = (refunded: boolean, payout = 'tunai') => ({
  id: uuid(1000), orderNumber: 'INV-S-1001', outletId: OUTLET, cashierId: 'c1', cashierName: 'Kasir Dua', customerId: null, customerName: null,
  status: refunded ? 'partially_refunded' : 'completed', paymentMethod: 'split', subtotal: 1251000, discountAmount: 0, taxAmount: 0, total: 1251000,
  amountPaid: 1351000, change: 100000, createdAt: NOW, tenderWarning: true, tenderWarningReason: 'noncash_overpay',
  tenders: [tender(1, 'qris', 751000, { reference: '8812345' }), tender(2, 'tunai', 500000, { tendered: 600000, change: 100000 })],
  items: [line(0, 'Parfum A', 2, 1000000, { refundedQty: refunded ? 1 : 0 }), line(1, 'Parfum B', 1, 251000)],
  ...(refunded ? { refundedAmount: 500000 } : {}),
  refunds: refunded ? [{
    id: uuid(1100), seq: 1, scope: 'partial', amount: 500000, computedAmount: 500000, claimedAmount: null, amountWarning: null, paymentMethod: payout,
    payoutSource: 'chosen', reason: 'Rusak/cacat', reasonCode: 'rusak_cacat', refundedByName: 'MV Admin', refundedAt: NOW, refundBusinessDate: '2026-01-03',
    items: [{ orderItemId: uuid(800), lineNo: 0, quantity: 1, amount: 500000 }],
  }] : [],
})
const singleOrder = () => ({
  id: uuid(2000), orderNumber: 'INV-S-2001', outletId: OUTLET, cashierId: 'c1', cashierName: 'Kasir Dua', customerId: null, customerName: null,
  status: 'completed', paymentMethod: 'qris', subtotal: 100000, discountAmount: 0, taxAmount: 0, total: 100000, change: 0, createdAt: NOW,
  tenders: [tender(1, 'qris', 100000)], items: [line(0, 'Parfum C', 1, 100000)], refunds: [],
})

export const splitOrderFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const orderCalls: URLSearchParams[] = []
  const posts: Array<Record<string, unknown>> = []
  let refunded = false
  let payout = 'tunai'

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/settings/app')) return route.fulfill({ json: { data: { paymentMethods: METHODS, splitTenderEnabled: true } } })
    if (path.endsWith('/reports/summary')) return route.fulfill({ json: { data: EMPTY_SUMMARY } })
    if (path.endsWith('/refund') && req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      posts.push(body)
      refunded = true
      payout = typeof body.payoutMethod === 'string' ? body.payoutMethod : 'tunai'
      return route.fulfill({ json: { data: splitOrder(true, payout) } })
    }
    if (path.endsWith('/orders')) {
      orderCalls.push(url.searchParams)
      const rows = url.searchParams.get('paymentMethod') === 'split' ? [splitOrder(refunded, payout)] : [splitOrder(refunded, payout), singleOrder()]
      return route.fulfill({ json: { data: rows, meta: { total: rows.length, page: Number(url.searchParams.get('page') ?? 1), limit: Number(url.searchParams.get('limit') ?? 50) } } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await openBackoffice(page)
  await navTo(page, 'reports')

  // list: the split order reads "Split-Payment", the single one keeps its method; the ⚠ Bayar badge titles the reason
  const splitRow = page.getByRole('button', { name: /INV-S-1001/ })
  await splitRow.waitFor()
  check(/Split-Payment/.test(await splitRow.innerText()), 'list shows Split-Payment for split')
  check(!/\bsplit\b/.test((await splitRow.innerText()).replace(/Split-Payment/g, '')), 'list never shows the raw split id')
  check((await page.getByRole('button', { name: /INV-S-2001/ }).innerText()).toLowerCase().includes('qris'), 'single-method order keeps its method')
  check((await splitRow.getByText('⚠ Bayar').getAttribute('title')) === 'Pembayaran non-tunai melebihi total', 'tender warning title')
  results.push({ step: 'list' })

  // detail: one row per payment line with reference and change; the single (synthetic) line is not repeated
  await splitRow.click()
  const lines = page.getByTestId('payment-lines')
  await lines.waitFor()
  const text = await lines.innerText()
  check(/QRIS/.test(text) && /ref 8812345/.test(text) && /751\.000/.test(text), `qris line ${text}`)
  check(/Tunai/.test(text) && /kembalian/.test(text) && /500\.000/.test(text), `cash line ${text}`)
  await page.getByRole('button', { name: /INV-S-2001/ }).click()
  check((await page.getByTestId('payment-lines').count()) === 0, 'a single-method order shows no payment block')
  results.push({ step: 'detail-lines' })

  // filter: Split-Payment is an option, the raw split id is not; selecting it reaches the API and explains itself
  const payFilter = page.getByLabel('Filter pembayaran')
  const optionTexts = await payFilter.locator('option').allInnerTexts()
  check(optionTexts.includes('Split-Payment') && !optionTexts.some((t) => t.trim().toLowerCase() === 'split'), `options ${optionTexts.join('|')}`)
  await payFilter.selectOption('split')
  await page.getByText(/Menampilkan transaksi Split-Payment/).waitFor()
  check(orderCalls.some((q) => q.get('paymentMethod') === 'split'), 'split filter query')
  await page.getByRole('button', { name: /INV-S-2001/ }).waitFor({ state: 'detached' })
  await payFilter.selectOption('qris')
  await page.getByText(/berisi metode QRIS/).waitFor()
  await payFilter.selectOption('')
  results.push({ step: 'filter' })

  // refund payout chips: split orders only, default (cash, the sale had cash) preselected; the chosen one is posted
  await page.getByRole('button', { name: /INV-S-1001/ }).click()
  await page.getByRole('button', { name: 'Proses Refund' }).click()
  const group = page.getByRole('radiogroup', { name: 'Dikembalikan lewat' })
  await group.waitFor()
  check((await group.getByRole('radio', { name: 'Tunai' }).getAttribute('aria-checked')) === 'true', 'cash preselected')
  check((await group.getByRole('radio', { name: 'QRIS' }).getAttribute('aria-checked')) === 'false', 'qris not selected')
  check((await group.getByRole('radio').count()) === 2, 'sale methods only (cash already among them)')
  await group.getByRole('radio', { name: 'QRIS' }).click()
  await page.getByRole('button', { name: /^Tambah Parfum B/ }).click()
  await page.locator('select').filter({ hasText: 'Pilih alasan' }).selectOption('rusak_cacat')
  await page.getByRole('button', { name: 'Lanjut', exact: true }).click()
  await page.getByRole('heading', { name: 'Konfirmasi refund' }).waitFor()
  await page.getByText('Dikembalikan lewat QRIS').waitFor()
  await page.getByRole('button', { name: 'Refund', exact: true }).last().click()
  await page.getByText('Refund ke-1').waitFor()
  check(posts.length === 1 && posts[0].payoutMethod === 'qris', `refund body carries payoutMethod ${JSON.stringify(posts[0])}`)
  await page.getByText(/Dikembalikan lewat QRIS \(dipilih saat refund\)/).waitFor()
  results.push({ step: 'refund-payout', body: posts[0] })

  // the single-method order shows no chips and posts no payoutMethod
  await page.getByRole('button', { name: /INV-S-2001/ }).click()
  await page.getByRole('button', { name: 'Proses Refund' }).last().click()
  check((await page.getByRole('radiogroup', { name: 'Dikembalikan lewat' }).count()) === 0, 'single-method order has no payout chips')
  results.push({ step: 'single-no-chips' })

  // Unduh CSV: Metode Bayar lists the lines, Metode Refund the payout
  await clickTab(page, 'export')
  await page.evaluate(() => {
    (window as any).__csv = []
    URL.createObjectURL = (b: any) => { (window as any).__csv.push(b.text()); return 'blob:synthetic' }
    HTMLAnchorElement.prototype.click = function () {}
  })
  await page.getByRole('button', { name: 'Unduh CSV', exact: true }).click()
  await page.waitForFunction(() => (window as any).__csv.length > 0)
  const csv = String(await page.evaluate(() => (window as any).__csv[0]))
  const rows = csv.replace(/^﻿/, '').split(/\r?\n/)
  check(rows[0].includes('Metode Bayar') && rows[0].includes('Metode Refund'), `csv header ${rows[0]}`)
  const row = rows.find((r) => r.startsWith('INV-S-1001')) ?? ''
  check(row.includes('QRIS 751.000; Tunai 500.000'), `csv split row ${row}`)
  check(row.includes('Tunai 500.000",QRIS,'), `csv refund payout ${row}`)
  results.push({ step: 'csv' })
  return results
}

export const splitToggleFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  const puts: Array<Record<string, unknown>> = []
  const server: Record<string, unknown> = { taxEnabled: false, taxRate: 0, roundingEnabled: false, paymentMethods: METHODS, receipt: { headerText: '', footerText: '' }, allowNegativeStock: true }
  const expectPuts = async (n: number) => { for (let i = 0; i < 50 && puts.length < n; i++) await new Promise((r) => setTimeout(r, 100)); check(puts.length === n, `expected ${n} saves, got ${puts.length}`) }

  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET, name: 'MV Outlet', isActive: true, timezone: 'Asia/Jakarta' }] } })
    if (path.endsWith('/settings/app')) {
      if (req.method() === 'PUT') {
        const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
        puts.push(body)
        Object.assign(server, body) // stateful: a later GET returns what the last PUT saved
        return route.fulfill({ json: { data: { ok: true } } })
      }
      return route.fulfill({ json: { data: server } })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await openBackoffice(page)
  await openTab(page, 'settings', 'transaksi')

  // off by default, with the D-50 warning on the card
  const toggle = page.getByRole('switch', { name: 'Bayar terpisah', exact: true })
  await toggle.waitFor()
  check((await toggle.getAttribute('aria-checked')) === 'false', 'off by default')
  await page.getByText(/Aktifkan hanya setelah semua tablet aktif memakai POS versi 2\.5\.0/).first().waitFor()
  await page.getByText(/Penjualan terpisah yang sudah antre di tablet tetap diterima server/).waitFor()
  results.push({ step: 'default-off-warning' })

  // switching on asks first; Batal leaves it off
  await toggle.click()
  await page.getByRole('heading', { name: 'Aktifkan Bayar terpisah?' }).waitFor()
  await page.getByText('Berlaku setelah Anda menekan Simpan perubahan.').waitFor()
  await page.getByRole('button', { name: 'Batal', exact: true }).click()
  check((await toggle.getAttribute('aria-checked')) === 'false', 'cancel keeps it off')
  check(puts.length === 0, 'nothing saved by the confirm dialog')
  await toggle.click()
  await page.getByRole('button', { name: 'Ya, aktifkan', exact: true }).click()
  check((await toggle.getAttribute('aria-checked')) === 'true', 'confirm switches it on')
  results.push({ step: 'confirm-on' })

  // the reserved id is refused before it is ever sent
  await page.getByLabel('Nama metode pembayaran baru').fill('Split')
  await page.locator('input[aria-label="Nama metode pembayaran baru"] + button').click()
  await page.getByRole('alert').filter({ hasText: 'dicadangkan' }).waitFor()
  results.push({ step: 'reserved-id' })

  // Simpan perubahan sends the flag; the bar confirms and the confirm text says when it applies
  await page.getByRole('button', { name: 'Simpan perubahan', exact: true }).click()
  await page.getByText('Pengaturan disimpan · tablet mengambilnya saat sinkron berikutnya').waitFor()
  check(puts.length === 1 && puts[0].splitTenderEnabled === true, `saved body ${JSON.stringify(puts[0])}`)
  check(!(puts[0].paymentMethods as Array<{ id: string }>).some((m) => m.id === 'split'), 'no split method saved')
  check((await toggle.getAttribute('aria-checked')) === 'true', 'the re-GET keeps the saved flag on')
  results.push({ step: 'save-flag', body: puts[0] })

  // a second save follows a second edit and omits the untouched key, so a stale tab cannot undo the kill switch
  await page.getByRole('switch', { name: 'Cetak struk otomatis', exact: true }).click()
  await page.getByRole('button', { name: 'Simpan perubahan', exact: true }).click()
  await expectPuts(2)
  check(!('splitTenderEnabled' in puts[1]), `untouched save omits the flag ${JSON.stringify(puts[1].splitTenderEnabled)}`)
  check((puts[1].receipt as Record<string, unknown>).autoPrint === true, 'second save carries the edit')
  await page.getByText('Pengaturan disimpan · tablet mengambilnya saat sinkron berikutnya').waitFor()
  await toggle.click()
  check((await toggle.getAttribute('aria-checked')) === 'false', 'off needs no confirm')
  results.push({ step: 'untouched-omits' })
  return results
}
