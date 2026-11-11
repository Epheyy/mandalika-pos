// Scenarios R1-R7 (reads at volume). Usage: node loadtest/run-reads.mjs [out.json]
// Admin + one outlet manager (L01, view_reports/manage_customers), 50 timed requests each after a warm-up.
// Reads are Redis-cached for 15 s (X-Cache: HIT), so every timed request carries a unique `_cb` query
// parameter to force a cold read (the handlers ignore unknown params). A few cache-HIT samples are
// reported separately for reference.
import { writeFileSync } from 'node:fs'
import { call, login, summarize, row, TABLE_HEAD, jakartaDay, psql } from './lib.mjs'

const N = 50
const WARM = 5
const today = jakartaDay(0)
const from30 = jakartaDay(-29)
const prevTo = jakartaDay(-30)
const prevFrom = jakartaDay(-59)
let cb = 0
const bust = () => `&_cb=${Date.now()}_${cb++}`

const admin = await login('admin@mandalika.local')
const mgr = await login('manager-l01@load.local')
const cash = await login('cashier-l01-1@load.local')
const outlets = (await call('GET', '/api/v1/outlets', { token: admin.token })).json
const outletList = outlets?.data ?? outlets
const l01 = outletList.find((o) => o.code === 'L01').id

// Sample values drawn from the data itself.
const orderNos = psql(`SELECT order_number FROM orders TABLESAMPLE SYSTEM (0.01) LIMIT 80`).split('\n')
const phones = psql(`SELECT phone FROM customers TABLESAMPLE SYSTEM (0.05) LIMIT 80`).split('\n')

const results = []
const rows = []

/** Run `mk(i)` -> path N times sequentially after WARM warm-ups; record one row. */
async function scenario(id, who, principal, mk, { cold = true } = {}) {
  if (process.env.LT_ONLY && !new RegExp(process.env.LT_ONLY).test(id)) return // rerun a subset: LT_ONLY='R4|R5'
  for (let i = 0; i < WARM; i++) await call('GET', mk(i) + (cold ? bust() : ''), { token: principal.token })
  const samples = []
  const statuses = {}
  for (let i = 0; i < N; i++) {
    const r = await call('GET', mk(WARM + i) + (cold ? bust() : ''), { token: principal.token })
    samples.push({ ms: r.ms, status: r.status })
    statuses[r.cache || '-'] = (statuses[r.cache || '-'] ?? 0) + 1
  }
  const s = summarize(`${id} ${who}`, samples)
  results.push({ ...s, cache: statuses })
  rows.push(s)
  console.log(row(s), JSON.stringify(statuses))
}

const who = [['admin', admin], ['manager', mgr]]
for (const [name, p] of who) {
  const allOutlets = name === 'admin' ? 'outletId=all&' : ''
  await scenario('R1 orders (1 outlet, today, p1)', name, p, () => `/api/v1/orders?outletId=${l01}&dateFrom=${today}&dateTo=${today}&page=1&limit=50`)
  await scenario('R2a orders all outlets 30d, page 1', name, p, () => `/api/v1/orders?${allOutlets}dateFrom=${from30}&dateTo=${today}&page=1&limit=50`)
  await scenario('R2b orders all outlets 30d, page 200', name, p, () => `/api/v1/orders?${allOutlets}dateFrom=${from30}&dateTo=${today}&page=200&limit=50`)
  await scenario('R3a orders q=<order number>', name, p, (i) => `/api/v1/orders?${allOutlets}q=${encodeURIComponent(orderNos[i % orderNos.length])}&page=1&limit=50`)
  await scenario('R3b orders q=<customer phone>', name, p, (i) => `/api/v1/orders?${allOutlets}q=${encodeURIComponent(phones[i % phones.length])}&page=1&limit=50`)
  await scenario('R4a reports/summary 30d all outlets', name, p, () => `/api/v1/reports/summary?${allOutlets}dateFrom=${from30}&dateTo=${today}`)
  await scenario('R4b reports/dashboard trend=day', name, p, () => `/api/v1/reports/dashboard?${allOutlets}dateFrom=${from30}&dateTo=${today}&prevDateFrom=${prevFrom}&prevDateTo=${prevTo}&trend=day&tzOffset=420`)
  await scenario('R4c refund-report 30d', name, p, () => `/api/v1/refund-report?${allOutlets}dateFrom=${from30}&dateTo=${today}`)
  await scenario('R5a customers?q=<name prefix>', name, p, (i) => `/api/v1/customers?q=${['Budi','Siti','Agus','Dewi','Eko','Rina','Joko','Wati','Andi','Sari'][i % 10]}&page=1&limit=50`)
  await scenario('R5b sync/customers/lookup?phone=', name, p, (i) => `/api/v1/sync/customers/lookup?phone=${phones[i % phones.length]}`)
}
// The real callers of the tablet endpoints are cashiers.
await scenario('R5b sync/customers/lookup?phone=', 'cashier L01', cash, (i) => `/api/v1/sync/customers/lookup?phone=${phones[i % phones.length]}`)
await scenario('R7 sync/pull', 'cashier L01', cash, () => `/api/v1/sync/pull?x=1`)
await scenario('R7 sync/version', 'cashier L01', cash, () => `/api/v1/sync/version?x=1`)

// Cache-HIT reference (same URL repeatedly inside the 15 s TTL).
{
  const url = `/api/v1/orders?outletId=all&dateFrom=${from30}&dateTo=${today}&page=1&limit=50`
  await call('GET', url, { token: admin.token })
  const samples = []
  for (let i = 0; i < N; i++) { const r = await call('GET', url, { token: admin.token }); samples.push({ ms: r.ms, status: r.status }) }
  const s = summarize('R2a admin, CACHE HIT (reference)', samples); rows.push(s); console.log(row(s))
}

// R6 month export: walk every page like fetchAllPages (limit 200, sequential), 30 days, all outlets.
async function exportWalk(label, principal, outletParam) {
  const t0 = performance.now()
  const pageSamples = []
  let total = Infinity, pages = 1, got = 0, bad = 0
  for (let page = 1; page <= pages; page++) {
    const r = await call('GET', `/api/v1/orders?${outletParam}dateFrom=${from30}&dateTo=${today}&page=${page}&limit=200`, { token: principal.token })
    pageSamples.push({ ms: r.ms, status: r.status })
    if (r.status !== 200) { bad++; break }
    const meta = r.json?.meta ?? r.json?.data?.meta
    const data = r.json?.data ?? []
    if (page === 1) { total = meta.total; pages = Math.max(1, Math.ceil(total / 200)) }
    got += data.length
  }
  const wall = performance.now() - t0
  const s = summarize(`${label} per page`, pageSamples)
  console.log(`${label}: ${pages} pages, ${got}/${total} rows, wall ${(wall / 1000).toFixed(1)} s`, row(s))
  return { label, pages, rowsFetched: got, total, wallSeconds: +(wall / 1000).toFixed(2), page: s, failedPages: bad }
}
const r6 = [await exportWalk('R6 export admin all outlets 30d', admin, 'outletId=all&'), await exportWalk('R6 export manager (L01) 30d', mgr, '')]

console.log('\n' + TABLE_HEAD + '\n' + rows.map(row).join('\n'))
writeFileSync(process.argv[2] ?? 'loadtest-reads.json', JSON.stringify({ at: new Date().toISOString(), N, WARM, rows, results, r6 }, null, 2))
