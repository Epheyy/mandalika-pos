/**
 * Redaction for anything that leaves the device as a log, error report or
 * shareable diagnostic (A37). Two tiers:
 *  - 'secrets': credential keys + Bearer/JWT/URL-secret string patterns only.
 *    Used for review reports to head office, which need the customer data.
 *  - 'logs': secrets + PII keys + email/phone string patterns + size caps.
 *
 * Contract: pure, never mutates its input (outbox items are the retry source
 * of truth), deep-copies, cycle-safe, depth-capped. The Go twin lives in
 * backend/internal/redact and runs the SAME vector file
 * (__fixtures__/redact-vectors.json) so the two cannot drift.
 */

export const REDACTED = '[REDACTED]'
export type RedactTier = 'secrets' | 'logs'

const SECRET_KEYS = new Set([
  'pin', 'pinhash', 'password', 'token', 'accesstoken', 'refreshtoken',
  'authorization', 'cookie', 'secret', 'apikey',
])
const PII_KEYS = new Set([
  'phone', 'email', 'customerphone', 'customeremail', 'customername', 'address', 'nik',
])
// Keys whose values are identifiers: never run the phone pattern over them.
const ID_KEYS = new Set(['idempotencykey', 'ordernumber', 'transferno', 'sku', 'barcode'])

export const MAX_DEPTH_LOGS = 8
export const MAX_DEPTH_SECRETS = 32
export const MAX_STRING_LOGS = 2048
export const MAX_TOTAL_BYTES_LOGS = 32 * 1024

// ASCII whitespace classes (not \s) so the Go twin matches exactly.
const BEARER_RE = /Bearer[ \t\r\n]+[A-Za-z0-9._~+/=-]+/g
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
const URL_SECRET_RE = /((?:^|[?&,;( \t\r\n])(?:token|access_token|key|sig|password)=)[^& \t\r\n#]*/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// Boundary before the number is captured (no lookbehind in the Go twin); the
// boundary after is checked by hand. '-' and '_' count as word characters so
// UUID/receipt fragments are never mistaken for phone numbers.
const PHONE_RE = /(^|[^0-9A-Za-z_-])((?:\+62|62|0)8[0-9]{7,12})/g
const WORD_CHAR_RE = /[0-9A-Za-z_-]/

function normKey(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, '')
}

function isIdKey(k: string): boolean {
  const lower = k.toLowerCase()
  return lower === 'id' || k.endsWith('Id') || lower.endsWith('_id') || ID_KEYS.has(normKey(k))
}

/** Redact patterns inside one string. `skipPhone` is set under identifier keys. */
export function redactString(s: string, tier: RedactTier = 'logs', skipPhone = false): string {
  let out = s
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(URL_SECRET_RE, `$1${REDACTED}`)
  if (tier === 'logs') {
    out = out.replace(EMAIL_RE, REDACTED)
    if (!skipPhone) {
      out = out.replace(PHONE_RE, (m: string, pre: string, _num: string, offset: number, whole: string) => {
        const next = whole.charAt(offset + m.length)
        if (next !== '' && WORD_CHAR_RE.test(next)) return m
        return pre + REDACTED
      })
    }
    if (out.length > MAX_STRING_LOGS) out = out.slice(0, MAX_STRING_LOGS) + '...[truncated]'
  }
  return out
}

interface Ctx {
  tier: RedactTier
  maxDepth: number
  seen: WeakSet<object>
}

function walk(v: unknown, depth: number, ctx: Ctx, skipPhone: boolean): unknown {
  if (v === null) return null
  if (v === undefined) return undefined
  switch (typeof v) {
    case 'string': return redactString(v, ctx.tier, skipPhone)
    case 'number': case 'boolean': return v
    case 'bigint': return v.toString()
    case 'function': case 'symbol': return '[Unserializable]'
  }
  const obj = v as object
  if (depth >= ctx.maxDepth) return '[MaxDepth]'
  if (ctx.seen.has(obj)) return '[Circular]'
  ctx.seen.add(obj)
  try {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
    if (v instanceof Error) {
      const e = v as Error & { cause?: unknown }
      const out: Record<string, unknown> = {
        name: walk(e.name, depth + 1, ctx, false),
        message: walk(e.message, depth + 1, ctx, false),
        stack: walk(e.stack ?? null, depth + 1, ctx, false),
      }
      if (e.cause !== undefined) out.cause = walk(e.cause, depth + 1, ctx, false)
      return out
    }
    if (Array.isArray(v)) return v.map((e) => walk(e, depth + 1, ctx, skipPhone) ?? null)
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const nk = normKey(k)
      if (SECRET_KEYS.has(nk) || (ctx.tier === 'logs' && PII_KEYS.has(nk))) {
        out[k] = REDACTED
        continue
      }
      const r = walk(val, depth + 1, ctx, isIdKey(k))
      if (r !== undefined) out[k] = r
    }
    return out
  } finally {
    ctx.seen.delete(obj)
  }
}

function run(value: unknown, tier: RedactTier): unknown {
  const ctx: Ctx = {
    tier,
    maxDepth: tier === 'logs' ? MAX_DEPTH_LOGS : MAX_DEPTH_SECRETS,
    seen: new WeakSet(),
  }
  const out = walk(value, 0, ctx, false)
  if (tier === 'logs') {
    const bytes = new TextEncoder().encode(JSON.stringify(out) ?? '').length
    if (bytes > MAX_TOTAL_BYTES_LOGS) return { _truncated: true, bytes }
  }
  return out
}

/** Secrets + PII + size caps: error logs, sync log, shared diagnostics. */
export function redactForLogs<T = unknown>(value: T): unknown {
  return run(value, 'logs')
}

/** Credentials only: review reports (head office needs the customer to resolve). */
export function redactSecrets<T = unknown>(value: T): unknown {
  return run(value, 'secrets')
}
