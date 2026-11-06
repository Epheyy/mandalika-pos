// Fase D3c: Persetujuan Stok filters are server params and URL state that never touch the sidebar badge, and the
// Integrasi ERP writes (Kirim sekarang, Kirim ulang) ask first and call the server once (synthetic API, no real backend).
import type { ScenarioPage } from './fixture'
import { openBackoffice, navItem } from './fixture'
import { BO_SHOT_VIEWPORTS, captureShot } from './shots'

const OUTLET_A = '00000000-0000-4000-8d3c-0000000000a1'
const OUTLET_B = '00000000-0000-4000-8d3c-0000000000b2'
const ERP_ROW = '00000000-0000-4000-8d3c-0000000000e1'
const ERP_ROW_2 = '00000000-0000-4000-8d3c-0000000000e2'
const user = { id: 'synthetic-admin', displayName: 'D3 Admin', role: 'admin', outletId: null, permissions: [] }
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }
const now = '2026-01-03T05:00:00Z'

const approval = (type: 'adjustment' | 'count', n: number) => ({
  type, id: `00000000-0000-4000-8d3c-00000000${type === 'count' ? 'c' : 'd'}${n}00`, number: type === 'count' ? `OPN-${n}` : `ADJ-${n}`,
  locationType: 'outlet', locationId: OUTLET_A, locationName: 'D3 Outlet A', requestedBy: 'u-1', requestedByName: 'Kasir D3',
  at: now, lines: 2, netDelta: type === 'count' ? 3 : -2,
})
const APPROVALS = [approval('adjustment', 1), approval('count', 1)]

const erpItem = (id: string, ref: string) => ({
  id, documentId: `00000000-0000-4000-8d3c-0000000000f${ref.slice(-1)}`, kind: 'adjust', locationType: 'outlet', locationId: OUTLET_A,
  locationName: 'D3 Outlet A', refType: 'adjustment', refId: `00000000-0000-4000-8d3c-0000000001${ref.slice(-1)}0`, refNumber: ref,
  part: 1, partCount: 1, status: 'dead', attempts: 5, nextAttemptAt: now, lastHttpStatus: 503, lastError: 'ERP down (uji)', holdReason: null,
  createdAt: now, updatedAt: now, deliveredAt: null,
})
const ERP_ITEMS = [erpItem(ERP_ROW, 'ADJ-9'), erpItem(ERP_ROW_2, 'ADJ-8')]

interface Calls {
  approvalLists: URLSearchParams[]
  erpLists: URLSearchParams[]
  relay: number
  retry: string[]
}

type RelayMode = 'ok' | 'off'

async function mockApi(page: ScenarioPage, relayMode: () => RelayMode) {
  const calls: Calls = { approvalLists: [], erpLists: [], relay: 0, retry: [] }
  await page.unrouteAll({ behavior: 'wait' })
  await page.route('http://127.0.0.1:59999/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.includes('/auth/')) return route.fulfill({ json: { data: { access: 'SYNTHETIC-NON-TOKEN', refresh: 'SYNTHETIC-NON-TOKEN', user } } })
    if (path.endsWith('/outlets')) return route.fulfill({ json: { data: [{ id: OUTLET_A, name: 'D3 Outlet A', isActive: true }, { id: OUTLET_B, name: 'D3 Outlet B', isActive: true }] } })
    if (path.endsWith('/inventory/approvals')) {
      calls.approvalLists.push(url.searchParams)
      const kind = url.searchParams.get('kind')
      const data = APPROVALS.filter((a) => !kind || a.type === kind)
      // pendingCount is the kind-blind total the badge shows.
      return route.fulfill({ json: { data, pendingCount: 3, meta: { total: data.length, page: 1, limit: Number(url.searchParams.get('limit') ?? 25) } } })
    }
    if (path.endsWith('/admin/erp/relay') && request.method() === 'POST') {
      calls.relay += 1
      await new Promise((resolve) => setTimeout(resolve, 400))
      const report = relayMode() === 'off'
        ? { disabled: true, reason: 'ERP_RELAY_ENABLED is off', claimed: 0, delivered: 0, replayed: 0, held: 0, retried: 0, dead: 0, released: 0 }
        : { disabled: false, claimed: 7, delivered: 3, replayed: 1, held: 2, retried: 1, dead: 0, released: 0 }
      return route.fulfill({ json: { data: report } })
    }
    const retry = /\/admin\/erp\/outbox\/([^/]+)\/retry$/.exec(path)
    if (retry && request.method() === 'POST') {
      calls.retry.push(retry[1])
      await new Promise((resolve) => setTimeout(resolve, 400))
      return route.fulfill({ json: { data: { ...ERP_ITEMS[0], status: 'pending' } } })
    }
    const detail = /\/admin\/erp\/outbox\/([^/]+)$/.exec(path)
    if (detail && request.method() === 'GET') {
      const item = ERP_ITEMS.find((i) => i.id === detail[1]) ?? ERP_ITEMS[0]
      return route.fulfill({ json: { data: { ...item, payload: { lines: 1 }, erpResponse: null } } })
    }
    if (path.endsWith('/admin/erp/outbox')) {
      calls.erpLists.push(url.searchParams)
      return route.fulfill({
        json: {
          data: ERP_ITEMS, meta: { total: ERP_ITEMS.length, page: 1, limit: 50 },
          counts: { pending: 0, held: 2, sending: 0, delivered: 5, replayed: 0, dead: 2 },
        },
      })
    }
    return route.fulfill({ json: { data: [], meta: { total: 0, page: 1, limit: 50 } } })
  })
  return calls
}

const hasFilter = (p: URLSearchParams) => p.has('kind') || p.has('outletId')

async function approvalsPart(page: ScenarioPage, calls: Calls, results: object[]) {
  const badge = page.getByLabel('3 menunggu persetujuan')
  await navItem(page, 'approvals').click()
  await page.getByRole('heading', { name: 'Persetujuan Stok' }).waitFor()
  await page.getByRole('button', { name: 'ADJ-1' }).waitFor()
  await page.getByRole('button', { name: 'OPN-1' }).waitFor()
  await badge.waitFor()

  await page.getByLabel('Jenis', { exact: true }).selectOption('count')
  await page.getByRole('button', { name: 'ADJ-1' }).waitFor({ state: 'detached' })
  check(page.url().includes('jenis=count'), `the type filter is in the URL, got ${page.url()}`)
  check(calls.approvalLists.some((p) => p.get('kind') === 'count'), 'the list asked the server for kind=count')
  await badge.waitFor()
  results.push({ step: 'type-filter-url-and-request' })
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'b4b-persetujuan', BO_SHOT_VIEWPORTS)

  await page.getByLabel('Outlet', { exact: true }).selectOption(OUTLET_B)
  await page.waitForFunction(() => location.hash.includes('outlet='))
  check(calls.approvalLists.some((p) => p.get('outletId') === OUTLET_B && p.get('kind') === 'count'), 'the list asked for outletId and kind together')
  await page.getByText('Dokumen gudang tidak tampil saat satu outlet dipilih.').waitFor()
  results.push({ step: 'outlet-filter-url-and-request' })

  // The sidebar badge asks on its own (page 1, limit 1) and never carries a filter.
  const badgeCalls = calls.approvalLists.filter((p) => p.get('limit') === '1')
  check(badgeCalls.length > 0, 'the badge polled')
  check(badgeCalls.every((p) => !hasFilter(p)), `the badge requests carry no filter: ${badgeCalls.map(String).join(' | ')}`)
  await badge.waitFor()
  results.push({ step: 'badge-unchanged' })

  await page.reload()
  await page.getByRole('heading', { name: 'Persetujuan Stok' }).waitFor()
  check((await page.getByLabel('Jenis', { exact: true }).inputValue()) === 'count', 'the type filter survives a reload')
  check((await page.getByLabel('Outlet', { exact: true }).inputValue()) === OUTLET_B, 'the outlet filter survives a reload')
  await page.getByRole('button', { name: 'Atur ulang filter (2)' }).click()
  await page.getByRole('button', { name: 'ADJ-1' }).waitFor()
  results.push({ step: 'reload-and-reset' })
}

async function erpPart(page: ScenarioPage, calls: Calls, results: object[], setRelay: (m: RelayMode) => void) {
  await navItem(page, 'erpOutbox').click()
  await page.getByRole('heading', { name: 'Integrasi ERP' }).waitFor()
  await page.getByRole('button', { name: 'ADJ-9' }).waitFor()
  check(calls.erpLists.some((p) => p.get('status') === 'dead' && p.get('limit') !== '1'), 'the default list asks for dead documents')
  if (process.env.A34C_RUN_DIR) await captureShot(page, 'b4b-erp', BO_SHOT_VIEWPORTS)
  check((await page.locator('main').innerText()).includes('D3 Outlet A'), 'the location shows its name')
  check(!(await page.locator('main').innerText()).includes('ERP_'), 'no setting names in the visible page')
  await page.getByRole('button', { name: 'Semua', exact: true }).click()
  await page.waitForFunction(() => location.hash.includes('status=semua'))
  check(calls.erpLists.some((p) => !p.has('status')), '"Semua" asks for every status')
  await page.reload()
  await page.getByRole('button', { name: 'ADJ-9' }).waitFor()
  check((await page.getByRole('button', { name: 'Semua', exact: true }).getAttribute('aria-pressed')) === 'true', '"Semua" survives a reload')
  results.push({ step: 'status-url-and-names' })

  // Kirim sekarang: Batal sends nothing, a double click on the confirm sends one run
  const runDialog = page.getByRole('alertdialog', { name: 'Kirim dokumen ke ERP sekarang?' })
  await page.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await runDialog.waitFor()
  await runDialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await runDialog.waitFor({ state: 'detached' })
  check(calls.relay === 0, 'Batal sends no relay run')
  await page.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await runDialog.waitFor()
  await runDialog.getByRole('button', { name: 'Kirim sekarang', exact: true }).dblclick()
  await runDialog.waitFor({ state: 'detached' })
  check(calls.relay === 1, `one relay run, got ${calls.relay}`)
  const result = page.getByRole('status', { name: 'Hasil pengiriman' })
  await result.waitFor()
  const text = await result.innerText()
  check(/Terkirim\s*4/.test(text) && /Ditahan\s*2/.test(text) && /Gagal\s*0/.test(text), `three counts, got ${text}`)
  results.push({ step: 'relay-asks-and-runs-once' })

  // A relay that is off explains itself without setting names; they sit behind Detail teknis
  setRelay('off')
  await page.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await runDialog.waitFor()
  await runDialog.getByRole('button', { name: 'Kirim sekarang', exact: true }).click()
  await runDialog.waitFor({ state: 'detached' })
  await page.getByText('Relay nonaktif: pengiriman ke ERP dimatikan di server.').waitFor()
  check(!(await page.locator('main').innerText()).includes('ERP_RELAY_ENABLED'), 'the setting name is hidden by default')
  await page.getByRole('button', { name: 'Detail teknis' }).click()
  await page.getByText('ERP_RELAY_ENABLED mati.').waitFor()
  check(calls.relay === 2, `two relay runs in total, got ${calls.relay}`)
  results.push({ step: 'relay-off-detail-teknis' })

  // Kirim ulang: Batal sends nothing, a double click on the confirm retries once
  const retryDialog = page.getByRole('alertdialog', { name: 'Kirim ulang ADJ-9?' })
  await page.getByRole('button', { name: 'ADJ-9' }).click()
  await page.getByRole('button', { name: 'Kirim ulang', exact: true }).click()
  await retryDialog.waitFor()
  check((await retryDialog.textContent())?.includes('Isi yang sama dikirim lagi ke ERP.') === true, 'the dialog says the same body is resent')
  await retryDialog.getByRole('button', { name: 'Batal', exact: true }).click()
  await retryDialog.waitFor({ state: 'detached' })
  check(calls.retry.length === 0, 'Batal sends no retry')
  await page.getByRole('button', { name: 'Kirim ulang', exact: true }).click()
  await retryDialog.waitFor()
  await retryDialog.getByRole('button', { name: 'Kirim ulang', exact: true }).dblclick()
  await retryDialog.waitFor({ state: 'detached' })
  await page.getByText('Dokumen dijadwalkan ulang.').waitFor()
  check(calls.retry.length === 1 && calls.retry[0] === ERP_ROW, `one retry for the opened document, got ${JSON.stringify(calls.retry)}`)
  results.push({ step: 'retry-asks-and-runs-once' })
}

export const approvalsErpFlow = async (page: ScenarioPage) => {
  const results: object[] = []
  let relay: RelayMode = 'ok'
  const calls = await mockApi(page, () => relay)
  await openBackoffice(page)
  await approvalsPart(page, calls, results)
  await erpPart(page, calls, results, (m) => { relay = m })
  return results
}
