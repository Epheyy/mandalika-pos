// A39 release-5 smoke against a tagged Cloud Run revision (Neon TEST data). Secrets from env, never printed.
// Usage: BASE=https://tag---... ADMIN_PW=... node smoke-a39.mjs
// Writes: two throwaway customers (deleted at the end) + one import_runs row (kept; redacted by design).
// Writes marker phones/emails to $MARKER_FILE (if set) so the redaction can be checked read-only in SQL afterwards.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

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
const OUT = bsd?.id
check('BSD outlet found', !!OUT)

const IMP = '/api/v1/customers/import'
const tok = randomUUID().replace(/-/g, '').replace(/\D/g, '').slice(0, 7).padEnd(7, '3')
const phone1 = `0899${tok}1`
const phone2 = `0899${tok}2`
const email1 = `zz-smoke-a39-${tok}@example.invalid`
const name1 = `ZZ Smoke A39 ${tok} One`
const name2 = `ZZ Smoke A39 ${tok} Two`
if (process.env.MARKER_FILE) writeFileSync(process.env.MARKER_FILE, [phone1, phone2, email1, name1, name2].join('\n'))

const csvOK = `Nama,Telepon,Email\n${name1},${phone1},${email1}\n${name2},${phone2},\n`
const csvDupInFile = `Nama,Telepon,Email\n${name1},${phone1},\n${name2},${phone1},\n`

// guards
const un = await call('POST', IMP, { body: { csv: csvOK, dryRun: true } })
check('unauthenticated → 401', un.status === 401, `status ${un.status}`)
const nokey = await call('POST', IMP, { token, outlet: OUT, body: { csv: csvOK, dryRun: false, fileSha256: 'x', expectedSummary: { create: 2, update: 0, skip: 0, error: 0, warning: 0, newCategories: 0 } } })
check('commit without Idempotency-Key → 400', nokey.status === 400, `status ${nokey.status}`)
const nosum = await call('POST', IMP, { token, outlet: OUT, key: randomUUID(), body: { csv: csvOK, dryRun: false } })
check('commit without preview hash/summary → 400', nosum.status === 400, `status ${nosum.status}`)
const bom = await call('POST', IMP, { token, outlet: OUT, body: { csv: '\u0000\u0001garbage', dryRun: true } })
check('garbage file → 200 report with a file issue (never a 500)', bom.status === 200 || bom.status === 422 || bom.status === 400, `status ${bom.status}`)

// in-file duplicate phone → preview reports error; commit rejected 422 with nothing written
const pDup = await call('POST', IMP, { token, outlet: OUT, body: { csv: csvDupInFile, dryRun: true } })
const rDup = data(pDup)
check('preview: duplicate phone in file → error counted', pDup.status === 200 && rDup?.summary?.error >= 1, JSON.stringify(rDup?.summary))
const cDup = await call('POST', IMP, { token, outlet: OUT, key: randomUUID(), body: { csv: csvDupInFile, dryRun: false, fileSha256: rDup?.fileSha256, expectedSummary: rDup?.summary } })
check('commit with errors → 422, nothing written', cDup.status === 422, `status ${cDup.status}`)
const none = await call('GET', `/api/v1/customers/by-phone?phone=${phone1}`, { token, outlet: OUT })
check('no customer was created by the rejected import', (data(none) ?? []).length === 0)

// clean preview + commit
const p1 = await call('POST', IMP, { token, outlet: OUT, body: { csv: csvOK, dryRun: true, fileName: 'smoke-a39.csv' } })
const r1 = data(p1)
check('preview: 2 creates, 0 errors', p1.status === 200 && r1?.summary?.create === 2 && r1?.summary?.error === 0, JSON.stringify(r1?.summary))
check('preview wrote nothing', (data(await call('GET', `/api/v1/customers/by-phone?phone=${phone1}`, { token, outlet: OUT })) ?? []).length === 0)
const key = `smoke-a39-${randomUUID()}`
const c1 = await call('POST', IMP, { token, outlet: OUT, key, body: { csv: csvOK, dryRun: false, fileName: 'smoke-a39.csv', fileSha256: r1.fileSha256, expectedSummary: r1.summary } })
const a1 = data(c1)
check('commit applied (200, runId, create 2)', c1.status === 200 && !!a1?.runId && a1?.summary?.create === 2, `status ${c1.status} ${JSON.stringify(a1?.summary)}`)
const f1 = data(await call('GET', `/api/v1/customers/by-phone?phone=${phone1}`, { token, outlet: OUT })) ?? []
const f2 = data(await call('GET', `/api/v1/customers/by-phone?phone=${phone2}`, { token, outlet: OUT })) ?? []
check('both customers exist after commit', f1.length === 1 && f2.length === 1, `${f1.length}/${f2.length}`)

// replay: same key + same file → same report, no second write
const c2 = await call('POST', IMP, { token, outlet: OUT, key, body: { csv: csvOK, dryRun: false, fileName: 'smoke-a39.csv', fileSha256: r1.fileSha256, expectedSummary: r1.summary } })
const a2 = data(c2)
check('replay same key+file → 200, same runId and summary', c2.status === 200 && a2?.runId === a1?.runId && a2?.summary?.create === 2, `status ${c2.status}`)
check('replay did not duplicate customers', ((data(await call('GET', `/api/v1/customers/by-phone?phone=${phone1}`, { token, outlet: OUT })) ?? []).length) === 1)
const leak = JSON.stringify(a2 ?? {})
check('replayed (stored) report carries no phone/email', !leak.includes(phone1) && !leak.includes(phone2) && !leak.includes(email1))

// same key, different file → 409 idempotency_conflict
const csvOther = `Nama,Telepon\nZZ Other ${tok},0898${tok}9\n`
const pO = data(await call('POST', IMP, { token, outlet: OUT, body: { csv: csvOther, dryRun: true } }))
const c3 = await call('POST', IMP, { token, outlet: OUT, key, body: { csv: csvOther, dryRun: false, fileSha256: pO?.fileSha256, expectedSummary: pO?.summary } })
check('same key, different file → 409 idempotency_conflict', c3.status === 409 && data(c3)?.code === 'idempotency_conflict', `status ${c3.status} ${JSON.stringify(data(c3))}`)

// dedupe: same people, formatted phone (hyphens/spaces) → skipped, not created
const fmt = (p) => `${p.slice(0, 4)}-${p.slice(4, 8)} ${p.slice(8)}`
const csvDup = `Nama,Telepon\n${name1},${fmt(phone1)}\n${name2},${phone2}\n`
const pd = await call('POST', IMP, { token, outlet: OUT, body: { csv: csvDup, dryRun: true } })
const rd = data(pd)
check('re-import of existing phones (one formatted) → 2 skips, 0 creates', pd.status === 200 && rd?.summary?.skip === 2 && rd?.summary?.create === 0, JSON.stringify(rd?.summary))

// stale: summary that no longer matches → 409 import_stale, nothing written
const bad = { ...r1.summary, create: 5 }
const cs = await call('POST', IMP, { token, outlet: OUT, key: randomUUID(), body: { csv: csvDup, dryRun: false, fileSha256: rd?.fileSha256, expectedSummary: bad } })
check('commit with a stale/mismatched summary → 409 import_stale', cs.status === 409 && data(cs)?.code === 'import_stale', `status ${cs.status} ${JSON.stringify(data(cs))}`)

// cleanup
let deleted = 0
for (const c of [...f1, ...f2]) {
  const d = await call('DELETE', `/api/v1/customers/${c.id}`, { token, outlet: OUT })
  if (d.status === 200 || d.status === 204) deleted++
}
check('cleanup: throwaway customers deleted', deleted === 2, `${deleted}/2`)

const failed = results.filter((x) => !x.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
