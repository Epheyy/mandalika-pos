// A44 release-4 smoke against a tagged Cloud Run revision (Neon TEST data). Secrets from env, never printed.
// Usage: BASE=https://tag---... ADMIN_PW=... node smoke-a44.mjs
// Writes: one throwaway product (deleted at the end), one oversold direct sale (refunded), one exception row
// (acknowledged with note "smoke"). Residue: 1 refunded order + 1 acknowledged exception row (immutable by design).
import { randomUUID } from 'node:crypto'

const BASE = process.env.BASE
const PW = process.env.ADMIN_PW
if (!BASE || !PW) throw new Error('BASE and ADMIN_PW required')
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }

async function call(method, path, { token, body, outlet, key } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (outlet) headers['X-Outlet-Id'] = outlet
  if (key) headers['Idempotency-Key'] = key
  let r; try { r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined }) } catch (e) { console.log(`NETERR ${method} ${path} ${e.cause?.code || e.message}`); throw e }
  let json = null
  try { json = await r.json() } catch { /* empty */ }
  return { status: r.status, json }
}
const data = (r) => r.json?.data ?? r.json

check('readyz', (await call('GET', '/readyz')).status === 200)
const login = process.env.ADMIN_TOKEN ? { status: 200, json: { data: { access: process.env.ADMIN_TOKEN } } } : await call('POST', '/api/v1/auth/login', { body: { email: 'admin@mandalika.test', password: PW } })
const token = data(login)?.access
check('admin login', login.status === 200 && !!token, `status ${login.status}`)
const outlets = await call('GET', '/api/v1/outlets', { token })
const bsd = (data(outlets) ?? []).find((o) => /bsd/i.test(o.name ?? '') || /bsd/i.test(o.code ?? ''))
check('BSD outlet found', !!bsd?.id, bsd ? bsd.name : 'none')
const OUT = bsd.id

// negative/validation checks on the new endpoints
const un = await call('GET', '/api/v1/oversell-report')
check('report unauthenticated → 401', un.status === 401, `status ${un.status}`)
const bd = await call('GET', '/api/v1/oversell-report?dateFrom=nope', { token, outlet: OUT })
check('report bad date → 400', bd.status === 400, `status ${bd.status}`)
const bk = await call('GET', '/api/v1/oversell-report?kind=bogus', { token, outlet: OUT })
check('report bad kind → 400', bk.status === 400, `status ${bk.status}`)
const ba = await call('POST', '/api/v1/oversell-records/acknowledge', { token, outlet: OUT, body: { ids: [] } })
check('acknowledge empty ids → 400', ba.status === 400, `status ${ba.status}`)
const bi = await call('POST', '/api/v1/oversell-records/acknowledge', { token, outlet: OUT, body: { ids: ['not-a-uuid'] } })
check('acknowledge bad id → 400', bi.status === 400, `status ${bi.status}`)

const openBefore = data(await call('GET', '/api/v1/oversell-report/open-count', { token, outlet: OUT }))?.openCount
check('open-count readable', Number.isInteger(openBefore), `openCount ${openBefore}`)

// throwaway product, zero stock at BSD
const cats = await call('GET', '/api/v1/categories', { token })
const cat = (data(cats) ?? [])[0]
check('a category exists', !!cat?.id)
const tag = randomUUID().slice(0, 8)
const mk = await call('POST', '/api/v1/products', { token, outlet: OUT, body: {
  brand: 'SMOKE', categoryId: cat.id, name: `ZZ smoke a44 ${tag}`, isActive: true,
  variants: [{ size: '1ml', price: 1000, sku: `ZZ44${tag}`, stock: 0 }],
} })
const pid = data(mk)?.id ?? data(mk)
check('create throwaway product', (mk.status === 200 || mk.status === 201) && typeof pid === 'string', `status ${mk.status}`)

const stockOf = async () => {
  const p = data(await call('GET', `/api/v1/products/${pid}`, { token, outlet: OUT }))
  return p?.variants?.find((v) => v.size === '1ml')?.stock
}
check('starts at stock 0', (await stockOf()) === 0, `stock ${await stockOf()}`)

// oversold direct sale: qty 2 against 0 → -2, shortfall 2
const key = `smoke-a44-${randomUUID()}`
const sale = { orderUuid: randomUUID(), paymentMethod: 'cash', amountPaid: 2000, items: [
  { productId: pid, productName: 'ZZ smoke', variantSize: '1ml', price: 1000, quantity: 2, subtotal: 2000 }] }
const s1 = await call('POST', '/api/v1/orders', { token, outlet: OUT, key, body: sale })
const order = data(s1)
check('sale beyond stock is accepted (never blocked)', s1.status === 200 || s1.status === 201, `status ${s1.status}`)
const oid = order?.id
check('order flagged stockWarning', order?.stockWarning === true, `stockWarning ${order?.stockWarning}`)
check('stock is the true negative (-2)', (await stockOf()) === -2, `stock ${await stockOf()}`)

// replay: same key → no second decrement, no second row
const s2 = await call('POST', '/api/v1/orders', { token, outlet: OUT, key, body: sale })
check('replay accepted', s2.status === 200 || s2.status === 201, `status ${s2.status}`)
check('replay did not move stock again', (await stockOf()) === -2, `stock ${await stockOf()}`)

// report
const rep = await call('GET', `/api/v1/oversell-report?productId=${pid}`, { token, outlet: OUT })
const sum = rep.json?.summary
const rows = rep.json?.data ?? []
check('report: 1 line, shortfall 2, one open', rep.status === 200 && sum?.lines === 1 && sum?.totalShortfall === 2 && sum?.openCount === 1, JSON.stringify(sum && { lines: sum.lines, total: sum.totalShortfall, open: sum.openCount }))
const row = rows[0]
check('record: kind shortage, 2 of 2 short, before 0 after -2, direct, open',
  row?.kind === 'shortage' && row?.quantity === 2 && row?.shortfall === 2 && row?.stockBefore === 0 && row?.stockAfter === -2 && row?.channel === 'direct' && !row?.acknowledgedAt,
  JSON.stringify(row && { k: row.kind, q: row.quantity, s: row.shortfall, b: row.stockBefore, a: row.stockAfter, c: row.channel }))
const openMid = data(await call('GET', '/api/v1/oversell-report/open-count', { token, outlet: OUT }))?.openCount
check('open-count went up by 1', openMid === openBefore + 1, `${openBefore} → ${openMid}`)

// acknowledge (idempotent)
const a1 = await call('POST', '/api/v1/oversell-records/acknowledge', { token, outlet: OUT, body: { ids: [row?.id], note: 'smoke' } })
check('acknowledge → 1', a1.status === 200 && data(a1)?.acknowledged === 1, `status ${a1.status} ${JSON.stringify(data(a1))}`)
const a2 = await call('POST', '/api/v1/oversell-records/acknowledge', { token, outlet: OUT, body: { ids: [row?.id], note: 'smoke' } })
check('acknowledge again → 0 (idempotent)', a2.status === 200 && data(a2)?.acknowledged === 0, JSON.stringify(data(a2)))
const ack = await call('GET', `/api/v1/oversell-report?productId=${pid}&status=acknowledged`, { token, outlet: OUT })
check('acknowledged filter shows it with note', ack.json?.data?.[0]?.acknowledgedAt && ack.json?.data?.[0]?.acknowledgeNote === 'smoke', '')
const openAfter = data(await call('GET', '/api/v1/oversell-report/open-count', { token, outlet: OUT }))?.openCount
check('open-count back to baseline', openAfter === openBefore, `${openAfter}`)

// refund restores the stock exactly; row stays
const rf = await call('POST', `/api/v1/orders/${oid}/refund`, { token, outlet: OUT, body: { reason: 'smoke a44' } })
check('refund ok', rf.status === 200 || rf.status === 201, `status ${rf.status}`)
check('refund restored stock to 0', (await stockOf()) === 0, `stock ${await stockOf()}`)
const rep2 = await call('GET', `/api/v1/oversell-report?productId=${pid}`, { token, outlet: OUT })
check('exception row survives the refund (immutable record)', rep2.json?.summary?.lines === 1 && rep2.json?.summary?.reversedShortfall === 2, JSON.stringify(rep2.json?.summary && { lines: rep2.json.summary.lines, reversed: rep2.json.summary.reversedShortfall }))

// cleanup
const del = await call('DELETE', `/api/v1/products/${pid}`, { token, outlet: OUT })
check('delete throwaway product', del.status === 200 || del.status === 204, `status ${del.status}`)

const failed = results.filter((x) => !x.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
