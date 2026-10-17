// Smoke the tagged revision for A14 stock counts + receipt device codes. Secrets from env (never printed).
// Usage: BASE=https://tag---... ADMIN_PW=... node smoke-release.mjs
// Writes: one planned stock count that is cancelled (no stock effect) and one throwaway device registration.
import { randomUUID } from 'node:crypto'

const BASE = process.env.BASE
const PW = process.env.ADMIN_PW
if (!BASE || !PW) throw new Error('BASE and ADMIN_PW required')
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }

async function call(method, path, { token, body, outlet } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (outlet) headers['X-Outlet-Id'] = outlet
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let json = null
  try { json = await r.json() } catch { /* empty */ }
  return { status: r.status, json }
}

const ready = await call('GET', '/readyz')
check('readyz', ready.status === 200, `status ${ready.status}`)

const login = await call('POST', '/api/v1/auth/login', { body: { email: 'admin@mandalika.test', password: PW } })
const auth = login.json?.data ?? login.json
check('admin login', login.status === 200 && !!auth?.access, `status ${login.status}`)
const token = auth.access

const outlets = await call('GET', '/api/v1/outlets', { token })
const bsd = (outlets.json?.data ?? []).find((o) => /bsd/i.test(o.name ?? '') || /bsd/i.test(o.code ?? ''))
check('BSD outlet found', !!bsd?.id, bsd ? `${bsd.name} (${bsd.code})` : 'none')

// Receipt device codes
const dev = randomUUID()
const d1 = await call('POST', '/api/v1/pos/devices/register', { token, outlet: bsd.id, body: { deviceId: dev } })
const code = d1.json?.data?.code
check('device register returns a code of 2+ letters', d1.status === 200 && /^[A-Z]{2,}$/.test(code ?? ''), `status ${d1.status} code ${code}`)
const d2 = await call('POST', '/api/v1/pos/devices/register', { token, outlet: bsd.id, body: { deviceId: dev } })
check('same device again → same code', d2.status === 200 && d2.json?.data?.code === code, `status ${d2.status}`)
const d3 = await call('POST', '/api/v1/pos/devices/register', { token, outlet: bsd.id, body: { deviceId: 'not-a-uuid' } })
check('bad deviceId → 400', d3.status === 400, `status ${d3.status}`)
const d4 = await call('POST', '/api/v1/pos/devices/register', { body: { deviceId: dev } })
check('unauthenticated → 401', d4.status === 401, `status ${d4.status}`)

// A14 stock count lifecycle (planned → cancelled; no stock effect)
const products = await call('GET', '/api/v1/products?limit=5', { token, outlet: bsd.id })
const p = (products.json?.data ?? []).find((x) => (x.variants ?? []).length > 0)
const v = p?.variants?.[0]
check('a product variant found', !!v, p ? `${p.name} ${v?.size}` : 'none')
const c1 = await call('POST', '/api/v1/stock-counts', { token, outlet: bsd.id, body: {
  name: `smoke ${new Date().toISOString()}`, items: [{ productId: p.id, productName: p.name, variantSize: v.size, sku: v.sku ?? '', frozenQty: 999999 }],
} })
const scId = c1.json?.data?.id ?? c1.json?.data
check('create planned count', (c1.status === 200 || c1.status === 201) && !!scId, `status ${c1.status}`)
const g1 = await call('GET', `/api/v1/stock-counts/${scId}`, { token, outlet: bsd.id })
const it = g1.json?.data?.items?.[0]
check('server froze its own qty (client 999999 ignored)', g1.status === 200 && it && it.frozenQty !== 999999 && 'baselineQty' in it, `frozen ${it?.frozenQty}`)
const x1 = await call('POST', `/api/v1/stock-counts/${scId}/complete`, { token, outlet: bsd.id, body: {} })
check('complete a planned count → 409', x1.status === 409, `status ${x1.status}`)
const u1 = await call('PUT', `/api/v1/stock-counts/${scId}`, { token, outlet: bsd.id, body: { status: 'bogus' } })
check('unknown status → 400', u1.status === 400, `status ${u1.status}`)
const u2 = await call('PUT', `/api/v1/stock-counts/${scId}`, { token, outlet: bsd.id, body: { status: 'cancelled' } })
check('cancel planned count', u2.status === 200, `status ${u2.status}`)
const u3 = await call('PUT', `/api/v1/stock-counts/${scId}`, { token, outlet: bsd.id, body: { status: 'in_progress' } })
check('start a cancelled count → 409', u3.status === 409, `status ${u3.status}`)

if (process.env.RELEASE2) {
  // A43: malformed optional body is 400 before any lookup (count is cancelled; no effect either way)
  const m1 = await fetch(`${BASE}/api/v1/stock-counts/${scId}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Outlet-Id': bsd.id }, body: '{"items": [' })
  check('malformed complete body → 400', m1.status === 400, `status ${m1.status}`)
  // A12: a shiftId that is not this outlet's is refused on direct routes (nothing written)
  const unknownShift = randomUUID()
  const cf = await call('POST', '/api/v1/cash-flows', { token, outlet: bsd.id, body: { shiftId: unknownShift, type: 'in', amount: 1, description: 'smoke' } })
  check('cash flow with foreign/unknown shift → 400', cf.status === 400, `status ${cf.status}`)
  const od = await call('POST', '/api/v1/orders', { token, outlet: bsd.id, body: { shiftId: unknownShift, idempotencyKey: `smoke:${randomUUID()}`, items: [], payments: [] } })
  check('direct order with foreign/unknown shift → 4xx, not 500', od.status >= 400 && od.status < 500, `status ${od.status}`)
  const sh = await call('GET', '/api/v1/shifts/current', { token, outlet: bsd.id })
  check('current shift readable', sh.status === 200 || sh.status === 404, `status ${sh.status}`)
}

const failed = results.filter((x) => !x.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
