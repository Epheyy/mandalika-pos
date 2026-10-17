// Smoke the A33 auth authority on a tagged revision. Secrets from env, never printed; tokens never printed.
// Usage: BASE=https://tag---... ADMIN_PW=... node smoke-auth.mjs
const BASE = process.env.BASE
const PW = process.env.ADMIN_PW
if (!BASE || !PW) throw new Error('BASE and ADMIN_PW required')
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }
const jti = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).jti } catch { return null } }

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let json = null
  try { json = await r.json() } catch { /* empty */ }
  return { status: r.status, json }
}
const tokens = (r) => r.json?.data ?? r.json ?? {}

const ready = await call('GET', '/readyz')
check('readyz 200', ready.status === 200, `status ${ready.status}`)
const health = await call('GET', '/livez')
check('healthz 200 and redis ok (not degraded)', health.status === 200 && JSON.stringify(health.json).includes('ok') && !JSON.stringify(health.json).includes('degraded'), `status ${health.status} ${JSON.stringify(health.json)}`)

const login = await call('POST', '/api/v1/auth/login', { body: { email: 'admin@mandalika.test', password: PW } })
const t0 = tokens(login)
check('login 200 with access + refresh', login.status === 200 && !!t0.access && !!t0.refresh, `status ${login.status}`)

const r1 = await call('POST', '/api/v1/auth/refresh', { body: { refresh: t0.refresh } })
const t1 = tokens(r1)
check('refresh R0 → R1', r1.status === 200 && !!t1.refresh && jti(t1.refresh) !== jti(t0.refresh), `status ${r1.status}`)

const r1b = await call('POST', '/api/v1/auth/refresh', { body: { refresh: t0.refresh } })
const t1b = tokens(r1b)
check('lost-response replay of R0 → same successor R1 (re-mint)', r1b.status === 200 && jti(t1b.refresh) === jti(t1.refresh), `status ${r1b.status}`)

const r2 = await call('POST', '/api/v1/auth/refresh', { body: { refresh: t1.refresh } })
const t2 = tokens(r2)
check('refresh R1 → R2', r2.status === 200 && !!t2.refresh && jti(t2.refresh) !== jti(t1.refresh), `status ${r2.status}`)

const deep = await call('POST', '/api/v1/auth/refresh', { body: { refresh: t0.refresh } })
check('replay two steps back (R0) → 401', deep.status === 401, `status ${deep.status}`)

const still = await call('POST', '/api/v1/auth/refresh', { body: { refresh: t2.refresh } })
const t3 = tokens(still)
check('session survives the refused deep replay (R2 → R3)', still.status === 200 && !!t3.refresh, `status ${still.status}`)

const outletsR = await call('GET', '/api/v1/outlets', { token: t3.access })
const outletId = (outletsR.json?.data ?? []).find((o) => /bsd/i.test(o.name ?? ''))?.id
const pullRes = await fetch(BASE + '/api/v1/sync/pull', { headers: { Authorization: `Bearer ${t3.access}`, 'X-Outlet-Id': outletId } })
const pull = { status: pullRes.status }
check('authenticated sync pull 200', pull.status === 200, `status ${pull.status}`)

const out = await call('POST', '/api/v1/auth/logout', { token: t3.access, body: { refresh: t3.refresh } })
check('logout 200', out.status === 200 || out.status === 204, `status ${out.status}`)
const after = await call('POST', '/api/v1/auth/refresh', { body: { refresh: t3.refresh } })
check('refresh after logout → 401', after.status === 401, `status ${after.status}`)

const big = await call('POST', '/api/v1/auth/refresh', { body: { refresh: 'x'.repeat(20000) } })
check('oversized refresh body → 400 (never 413)', big.status === 400, `status ${big.status}`)

const failed = results.filter((x) => !x).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
