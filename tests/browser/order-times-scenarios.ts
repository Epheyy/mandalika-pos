// F12/F26 (QA retest R10): order times are unambiguous. POS Riwayat labels the chips "Hari shift", explains them in
// visible text, and rows show the real date and time (never "Hari ini"/"Kemarin"), with a second "Diterima server"
// time for an offline sale. The Backoffice order list shows the same two times. Synthetic API only.
import type { ScenarioPage } from './fixture'
import { openBackoffice, navTo } from './fixture'
import { setupPos } from './pos-scenarios'
import { hubRoutes } from './backoffice-refund-scenarios'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
const OUTLET = '00000000-0000-4000-8300-000000000090'
const uuid = (n: number) => `00000000-0000-4000-8e12-${String(n).padStart(12, '0')}`
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

const jakartaDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d) // YYYY-MM-DD

const order = (n: number, number: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id: uuid(n), orderNumber: number, outletId: OUTLET, cashierId: 'c1', cashierName: 'Kasir Satu', customerId: null, customerName: null,
  status: 'completed', paymentMethod: 'cash', subtotal: 100000, discountAmount: 0, taxAmount: 0, total: 100000, amountPaid: 100000, change: 0,
  createdAt, items: [], ...extra,
})

export const posHistoryTimes = async (page: ScenarioPage) => {
  // Overnight shift: opened yesterday 22:00 WIB; a sale at 01:31 today (calendar today, shift day yesterday).
  const today = jakartaDay(new Date())
  const [, mm, dd] = today.split('-')
  const stamp = `${dd} ${MONTHS[Number(mm) - 1]}`
  const overnight = order(1, 'INV-N-0001', `${today}T01:31:00+07:00`)
  const offline = order(2, 'INV-N-0002', `${today}T08:46:00+07:00`, { clientCreatedAt: `${today}T01:40:00+07:00` })
  const old = order(3, 'INV-N-0003', `${today}T09:05:00+07:00`, { clientCreatedAt: null })
  await setupPos(page, {
    extraRoute: async (route, path) => {
      if (!path.endsWith('/orders')) return false
      await route.fulfill({ json: { data: [overnight, offline, old], meta: { total: 3, page: 1, limit: 50 } } })
      return true
    },
  })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'Riwayat', exact: true }).last().click()
  await page.getByRole('heading', { name: 'Riwayat Transaksi' }).waitFor()
  await page.getByText('#INV-N-0001', { exact: false }).waitFor()

  const dialog = page.getByRole('dialog')
  const group = dialog.getByRole('group', { name: 'Hari shift' })
  await group.waitFor()
  const hint = (await dialog.getByTestId('history-shift-day-hint').innerText()).toLowerCase()
  check(hint.includes('hari shift') && hint.includes('bukan jam'), `the chip explanation is visible text: ${hint}`)
  check(!(await group.getAttribute('title')), 'no hover-only explanation on the chip group')

  const rows = await dialog.getByTestId('history-row-time').allInnerTexts()
  check(rows.length === 3, `three rows: ${rows.join('|')}`)
  check(rows[0] === `${stamp} 01:31`, `overnight sale shows its real date and time: ${rows[0]}`)
  check(rows[1] === `${stamp} 01:40`, `offline sale shows the tablet time as the sale time: ${rows[1]}`)
  check(rows[2] === `${stamp} 09:05`, `a row without clientCreatedAt falls back to createdAt: ${rows[2]}`)
  for (const r of rows) check(!/Hari ini|Kemarin/.test(r), `row time never uses a chip word: ${r}`)
  const received = await dialog.getByTestId('history-row-received').allInnerTexts()
  check(received.length === 1 && received[0]!.includes('Diterima server 08:46'), `only the offline sale shows the server time: ${received.join('|')}`)
  return [{ rows, received, hint }]
}

export const boOrderTimes = async (page: ScenarioPage) => {
  const base = (n: number, number: string, createdAt: string, extra: Record<string, unknown> = {}) =>
    ({ ...order(n, number, createdAt, extra), outletId: '00000000-0000-4000-8f69-0000000000a1' })
  const offline = base(1, 'INV-T-0001', '2026-01-03T08:46:00+07:00', { clientCreatedAt: '2026-01-03T01:31:00+07:00', businessDate: '2026-01-02' })
  const old = base(2, 'INV-T-0002', '2026-01-03T09:05:00+07:00', { clientCreatedAt: null })
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (await hubRoutes(route, path)) return
    if (path.endsWith('/orders')) return route.fulfill({ json: { data: [offline, old], meta: { total: 2, page: 1, limit: 50 } } })
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  await openBackoffice(page)
  await navTo(page, 'reports')
  await page.getByText('INV-T-0001').first().waitFor()
  const main = await page.getByTestId('order-time').allInnerTexts()
  const received = await page.getByTestId('order-received').allInnerTexts()
  check(main[0] === '03 Jan 2026 01:31', `offline order shows the tablet time as the sale time: ${main[0]}`)
  check(main[1] === '03 Jan 2026 09:05', `a row without clientCreatedAt falls back to createdAt: ${main[1]}`)
  check(received.length === 1 && received[0]!.includes('Diterima server 08:46'), `only the offline order shows the server time: ${received.join('|')}`)
  return [{ main, received }]
}
