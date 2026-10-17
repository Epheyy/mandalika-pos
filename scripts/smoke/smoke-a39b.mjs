// A39 follow-up smoke on a tagged revision: ingredient SKU assign / unit_mismatch / one-target-per-ingredient.
// Writes: one throwaway ingredient (deleted at the end). Secrets from env, never printed.
import { randomUUID } from 'node:crypto'
const BASE = process.env.BASE, PW = process.env.ADMIN_PW
if (!BASE || !PW) throw new Error('BASE and ADMIN_PW required')
const results = []
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`) }
const skip = (n, x = '') => console.log(`SKIP ${n}${x ? ' — ' + x : ''}`)
async function call(method, path, { token, body, outlet, key } = {}) {
  const h = { 'Content-Type': 'application/json' }
  if (token) h.Authorization = `Bearer ${token}`
  if (outlet) h['X-Outlet-Id'] = outlet
  if (key) h['Idempotency-Key'] = key
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch { /* empty */ }
  return { status: r.status, json: j }
}
const data = (r) => r.json?.data ?? r.json
const login = await call('POST', '/api/v1/auth/login', { body: { email: 'admin@mandalika.test', password: PW } })
const token = data(login)?.access
check('admin login', login.status === 200 && !!token)
const outs = data(await call('GET', '/api/v1/outlets', { token })) ?? []
const OUT = outs.find((o) => /bsd/i.test(o.name ?? ''))?.id
const tag = randomUUID().replace(/\D/g, '').slice(0, 6).padEnd(6, '4')
const name = `ZZ Smoke Bahan ${tag}`
const mk = await call('POST', '/api/v1/ingredients', { token, outlet: OUT, body: { name, unit: 'ml', isActive: true } })
if (mk.status === 404 || mk.status === 403) { skip('ingredient module disabled/forbidden on this env', `status ${mk.status}`); process.exit(0) }
const id = data(mk)?.id ?? data(mk)
check('create throwaway ingredient (no SKU given)', (mk.status === 200 || mk.status === 201) && typeof id === 'string', `status ${mk.status}`)
const list = data(await call('GET', '/api/v1/ingredients?limit=500', { token, outlet: OUT })) ?? []
const mine = list.find((x) => x.id === id)
const blank = !mine?.sku
console.log(`info: created ingredient has ${blank ? 'a BLANK' : 'an auto-generated'} SKU`)
const IMP = '/api/v1/ingredients/import'
const preview = (csv) => call('POST', IMP, { token, outlet: OUT, body: { csv, dryRun: true } })
if (blank) {
  const newSku = `ZZSM${tag}`
  const p1 = data(await preview(`Nama,SKU,Satuan\n${name},${newSku},ml\n`))
  check('new SKU + exact name of ONE blank-SKU ingredient → update (assign), not create', p1?.summary?.update === 1 && p1?.summary?.create === 0, JSON.stringify(p1?.summary))
  const p2 = data(await preview(`Nama,SKU,Satuan\n${name},${newSku},kg\n`))
  check('assign with a different unit → row error unit_mismatch', p2?.summary?.error === 1 && (p2?.issues ?? []).some((i) => i.code === 'unit_mismatch'), JSON.stringify(p2?.summary))
  const p3 = data(await preview(`Nama,SKU,Satuan\n${name},${newSku},ml\n${name},,ml\n`))
  check('two rows targeting one ingredient → duplicate_in_file', p3?.summary?.error >= 1 && (p3?.issues ?? []).some((i) => i.code === 'duplicate_in_file'), JSON.stringify(p3?.summary))
  const k = `smoke-a39b-${randomUUID()}`
  const c = await call('POST', IMP, { token, outlet: OUT, key: k, body: { csv: `Nama,SKU,Satuan\n${name},${newSku},ml\n`, dryRun: false, fileSha256: p1?.fileSha256, expectedSummary: p1?.summary } })
  check('commit assigns the SKU', c.status === 200 && data(c)?.summary?.update === 1, `status ${c.status}`)
  const after = (data(await call('GET', '/api/v1/ingredients?limit=500', { token, outlet: OUT })) ?? []).filter((x) => (x.name ?? '') === name)
  check('exactly one ingredient with that name, now carrying the SKU (no duplicate)', after.length === 1 && after[0].sku === newSku, `${after.length} found sku=${after[0]?.sku}`)
} else {
  skip('blank-SKU assign path not testable via API on this env (CreateIngredient auto-assigns a SKU)', `sku=${mine?.sku}`)
}
const d = await call('DELETE', `/api/v1/ingredients/${id}`, { token, outlet: OUT })
check('cleanup: throwaway ingredient deleted', d.status === 200 || d.status === 204, `status ${d.status}`)
const failed = results.filter((x) => !x).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
