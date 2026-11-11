// Shared helpers for the load-test step-1 drivers. Node 24, no dependencies.
// Local only: every request goes to http://localhost:8090 (assertLocal refuses anything else).
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

export const BASE = process.env.LT_BASE ?? 'http://localhost:8090'
export const REDIS_CONTAINER = process.env.LT_REDIS_CONTAINER ?? 'roletest-redis-1'
export const PG_CONTAINER = process.env.LT_PG_CONTAINER ?? 'roletest-postgres-1'
export const REDIS_DB = process.env.LT_REDIS_DB ?? '1' // must match REDIS_URL in backend/.env

const host = new URL(BASE).hostname
if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`refusing non-local base URL ${BASE}`)

/** SEED_ADMIN_PASSWORD from backend/.env (gitignored). Every load user shares it; never printed. */
export function password() {
  const env = readFileSync(new URL('../backend/.env', import.meta.url), 'utf8')
  const m = env.match(/^SEED_ADMIN_PASSWORD=(.+)$/m)
  if (!m) throw new Error('SEED_ADMIN_PASSWORD missing in backend/.env (run node loadtest/gen-env.mjs)')
  return m[1].trim()
}

/** Run SQL in the throw-away database inside the roletest Postgres container; returns trimmed stdout. */
export function psql(sql, db = 'mandalika_load') {
  return execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'mandalika', '-d', db, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim()
}

/** The strict per-IP "auth" bucket (10/min, hard-coded in server.go) is cleared in OUR Redis db only. */
export function clearAuthBucket() {
  execFileSync(
    'docker',
    ['exec', REDIS_CONTAINER, 'redis-cli', '-n', REDIS_DB, 'EVAL',
      "for _,k in ipairs(redis.call('keys','rl:auth:*')) do redis.call('del',k) end return 1", '0'],
    { encoding: 'utf8' },
  )
}

/** Timed request. Never throws on HTTP errors; network failures are status 0. */
export async function call(method, path, { token, outlet, body, headers } = {}) {
  const h = { ...(headers ?? {}) }
  if (token) h.Authorization = `Bearer ${token}`
  if (outlet) h['X-Outlet-Id'] = outlet
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const t0 = performance.now()
  let res, text = ''
  try {
    res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    text = await res.text()
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, error: String(e?.cause?.code ?? e?.message ?? e), json: null, cache: '' }
  }
  const ms = performance.now() - t0
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON error body */ }
  return { status: res.status, ms, json, text, bytes: text.length, cache: res.headers.get('x-cache') ?? '' }
}

export async function login(email) {
  clearAuthBucket()
  const r = await call('POST', '/api/v1/auth/login', { body: { email, password: password() } })
  const tok = r.json?.data?.accessToken ?? r.json?.data?.access ?? r.json?.accessToken ?? r.json?.access
  if (r.status !== 200 || !tok) throw new Error(`login failed for ${email}: HTTP ${r.status} ${r.text?.slice(0, 120)}`)
  return { token: tok, user: r.json?.data?.user ?? r.json?.user }
}

/** Nearest-rank percentile on a sorted array. */
function pct(sorted, p) {
  if (!sorted.length) return NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

/** samples: [{ms,status}] -> row with p50/p95/p99/max (ms), n, and error counts by status. */
export function summarize(label, samples) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b)
  const errs = {}
  for (const s of samples) if (s.status < 200 || s.status >= 300) errs[s.status] = (errs[s.status] ?? 0) + 1
  return {
    label, n: samples.length,
    p50: +pct(ms, 50).toFixed(1), p95: +pct(ms, 95).toFixed(1), p99: +pct(ms, 99).toFixed(1), max: +(ms.at(-1) ?? NaN).toFixed(1),
    errors: errs,
  }
}

export function row(r) {
  const e = Object.keys(r.errors).length ? JSON.stringify(r.errors) : '-'
  return `| ${r.label} | ${r.n} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${e} |`
}
export const TABLE_HEAD = '| Request | n | p50 ms | p95 ms | p99 ms | max ms | errors by status |\n|---|---|---|---|---|---|---|'

/** Today's date in Asia/Jakarta (all seeded outlets) shifted by `days`, as YYYY-MM-DD. */
export function jakartaDay(days = 0) {
  const d = new Date(Date.now() + days * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
