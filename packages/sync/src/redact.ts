/**
 * Redaction for anything that leaves the device as a log, error report or
 * shareable diagnostic (A37). Two tiers:
 *  - 'secrets': credential keys + Bearer/Basic/JWT/URL/JSON-secret string
 *    patterns only. Used for review reports to head office, which need the
 *    customer data.
 *  - 'logs': secrets + PII keys + email/phone string patterns + size caps.
 *
 * Contract: pure, never mutates its input (outbox items are the retry source
 * of truth), deep-copies, cycle-safe, depth- and node-capped. The Go twin lives
 * in backend/internal/redact and runs the SAME vector file
 * (__fixtures__/redact-vectors.json) so the two cannot drift. Strings are cut by
 * code point, and the logs tier measures output with a deterministic estimate
 * (UTF-8 bytes of keys and strings plus fixed per-node overhead), never an
 * encoder, so truncation decisions are identical in both languages.
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
const CONTACT_KEYS = new Set(['phone', 'email', 'customerphone', 'customeremail'])
// Keys whose values are identifiers: never run the phone pattern over them.
const ID_KEYS = new Set(['idempotencykey', 'ordernumber', 'transferno', 'sku', 'barcode'])

export const MAX_DEPTH_LOGS = 8
export const MAX_DEPTH_SECRETS = 32
export const MAX_STRING_LOGS = 2048 // code points
export const MAX_STACK_LOGS = 4096 // code points, for fields keyed "stack"
export const MAX_TOTAL_BYTES_LOGS = 32 * 1024
const PRE_CUT_FACTOR = 4 // strings are cut to factor*cap before any regex runs
const MAX_NODES_LOGS = 5000
const MAX_NODES_SECRETS = 100000
const NODE_OVERHEAD = 6
const KEY_OVERHEAD = 4
const TRUNCATED_SUFFIX = '...[truncated]'

// ASCII whitespace classes (not \s) so the Go twin matches exactly. Quantifiers
// are bounded (RE2 allows at most 1000) so adversarial input cannot backtrack.
const BEARER_RE = /Bearer[ \t\r\n]+[A-Za-z0-9._~+/=-]+/gi
const BASIC_RE = /(Authorization:[ \t]*)Basic[ \t]+[A-Za-z0-9+/]+={0,2}/gi
// JWT segments are unbounded: the logs-tier pre-cut (4x the cap) bounds the input.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
// JSON inside a string: plain or backslash-escaped (double-encoded) quotes, and a value that is a
// whole string literal (escaped quotes inside it included), a number or a bare word.
const JSON_SECRET_RE = /\\?"(pin|pinhash|password|token|accesstoken|refreshtoken|authorization|cookie|secret|apikey|access_token|refresh_token|api_key)\\?"[ \t]*:[ \t]*(?:\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|[^,}\] \t\r\n"\\]+)/gi
const URL_SECRET_RE = /((?:^|[?&,;( \t\r\n])(?:token|access_token|key|sig|password|pin|api_key|apikey)=)[^& \t\r\n#]*/gi
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g
// '-' and '_' count as word characters so UUID/receipt fragments are never mistaken for phone numbers.
const WORD_CHAR_RE = /[0-9A-Za-z_-]/
const NUL_RE = /\0/g

function normKey(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, '')
}

function isIdKey(k: string): boolean {
  const lower = k.toLowerCase()
  return lower === 'id' || k.endsWith('Id') || lower.endsWith('_id') || ID_KEYS.has(normKey(k))
}

/** s limited to n code points (never splits a surrogate pair). */
function cutCodePoints(s: string, n: number): string {
  if (s.length <= n) return s
  // The first n code points always sit inside the first 2n code units: slice the raw string
  // first so a huge string is never expanded into an array.
  const cps = Array.from(s.slice(0, 2 * n))
  return cps.length <= n && s.length <= 2 * n ? s : cps.slice(0, n).join('')
}

function exceedsCodePoints(s: string, n: number): boolean {
  // 2n+2 code units hold more than n code points whenever the string is that long.
  return s.length > n && Array.from(s.slice(0, 2 * n + 2)).length > n
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isPhoneSep = (c: string): boolean => c === ' ' || c === '.' || c === '-'
const isWordChar = (c: string): boolean => WORD_CHAR_RE.test(c)

/**
 * Replace Indonesian phone numbers: a prefix (0, 62 or +62) directly followed by 8 (one separator
 * may sit between 62/+62 and the 8), then further digit runs of at least 4 digits joined by ONE
 * separator (space, dot, hyphen, or ")" with an optional space). Total digits must be
 * prefix+1+7 .. prefix+1+12. Whole runs only: when the next run would exceed the maximum the
 * number ends there, but it must then be followed by a non-word character ('-' counts as a word
 * character, so a long hyphenated code is never cut). The Go twin implements the same scanner.
 */
function redactPhones(s: string): string {
  let out = ''
  let last = 0
  let i = 0
  const n = s.length
  while (i < n) {
    if (i > 0 && isWordChar(s[i - 1])) { i++; continue }
    let pdig = 0
    let q = i
    if (s.startsWith('+62', i)) { pdig = 2; q = i + 3 }
    else if (s.startsWith('62', i)) { pdig = 2; q = i + 2 }
    else if (s[i] === '0') { pdig = 1; q = i + 1 }
    else { i++; continue }
    if (pdig === 2 && q < n && isPhoneSep(s[q])) q++
    if (q >= n || s[q] !== '8') { i++; continue }
    const maxDigits = pdig + 1 + 12
    const minDigits = pdig + 1 + 7
    let r = q
    while (r < n && isDigit(s[r])) r++
    let digits = pdig + (r - q)
    let end = r
    let paren = false
    if (digits > maxDigits) { i = end; continue }
    while (end < n) {
      let sepEnd = -1
      let isParen = false
      if (isPhoneSep(s[end])) sepEnd = end + 1
      else if (s[end] === ')') {
        sepEnd = end + 1
        isParen = true
        if (sepEnd < n && s[sepEnd] === ' ') sepEnd++
      }
      if (sepEnd < 0) break
      let v = sepEnd
      while (v < n && isDigit(s[v])) v++
      if (v - sepEnd < 4 || digits + (v - sepEnd) > maxDigits) break
      digits += v - sepEnd
      end = v
      paren = paren || isParen
    }
    if (digits < minDigits || (end < n && isWordChar(s[end]))) { i = end; continue }
    const begin = paren && i > 0 && s[i - 1] === '(' ? i - 1 : i
    out += s.slice(last, begin) + REDACTED
    last = end
    i = end
  }
  return out + s.slice(last)
}

function utf8Len(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++ }
    else n += 3
  }
  return n
}

function redactStr(s: string, tier: RedactTier, skipPhone: boolean, capCP: number): string {
  let out = s.replace(NUL_RE, '')
  if (tier === 'logs') out = cutCodePoints(out, capCP * PRE_CUT_FACTOR)
  out = out
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(BASIC_RE, `$1Basic ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(JSON_SECRET_RE, `"$1":"${REDACTED}"`)
    .replace(URL_SECRET_RE, `$1${REDACTED}`)
  if (tier !== 'logs') return out
  out = out.replace(EMAIL_RE, REDACTED)
  if (!skipPhone) out = redactPhones(out)
  if (exceedsCodePoints(out, capCP)) out = cutCodePoints(out, capCP) + TRUNCATED_SUFFIX
  return out
}

/** Redact patterns inside one string. `skipPhone` is set under identifier keys. */
export function redactString(s: string, tier: RedactTier = 'logs', skipPhone = false): string {
  return redactStr(s, tier, skipPhone, MAX_STRING_LOGS)
}

interface Ctx {
  tier: RedactTier
  maxDepth: number
  maxNodes: number
  maxBytes: number // 0 = unlimited
  nodes: number
  bytes: number
  over: boolean
  seen: WeakSet<object>
}

function account(ctx: Ctx, n: number): void {
  ctx.bytes += n
  if (ctx.maxBytes > 0 && ctx.bytes > ctx.maxBytes) ctx.over = true
}

function visit(ctx: Ctx): boolean {
  ctx.nodes++
  if (ctx.nodes > ctx.maxNodes) ctx.over = true
  return !ctx.over
}

const BASE_ERROR_KEYS = new Set(['name', 'message', 'stack', 'cause'])

function walk(v: unknown, depth: number, ctx: Ctx, skipPhone: boolean, isCustomer = false, capCP = MAX_STRING_LOGS): unknown {
  if (!visit(ctx)) return undefined
  if (v === null || v === undefined) {
    account(ctx, NODE_OVERHEAD)
    return v === null ? null : undefined
  }
  switch (typeof v) {
    case 'string': {
      const out = redactStr(v, ctx.tier, skipPhone, capCP)
      account(ctx, utf8Len(out) + 2)
      return out
    }
    case 'number': case 'boolean':
      account(ctx, NODE_OVERHEAD)
      return v
    case 'bigint':
      account(ctx, NODE_OVERHEAD)
      return v.toString()
    case 'function': case 'symbol':
      account(ctx, NODE_OVERHEAD)
      return '[Unserializable]'
  }
  const obj = v as object
  if (depth >= ctx.maxDepth) return '[MaxDepth]'
  if (ctx.seen.has(obj)) return '[Circular]'
  ctx.seen.add(obj)
  try {
    if (v instanceof Date) {
      account(ctx, NODE_OVERHEAD)
      return Number.isNaN(v.getTime()) ? null : v.toISOString()
    }
    account(ctx, NODE_OVERHEAD)
    if (v instanceof Error) {
      const e = v as Error & { cause?: unknown }
      const out: Record<string, unknown> = {
        name: walk(e.name, depth + 1, ctx, false),
        message: walk(e.message, depth + 1, ctx, false),
        stack: walk(e.stack ?? null, depth + 1, ctx, false, false, MAX_STACK_LOGS),
      }
      if (e.cause !== undefined) out.cause = walk(e.cause, depth + 1, ctx, false)
      // Primitive custom props (status, code, ...) survive; key rules still apply.
      for (const [k, val] of Object.entries(e)) {
        if (BASE_ERROR_KEYS.has(k) || ctx.over) continue
        if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') continue
        const nk = normKey(k)
        if (SECRET_KEYS.has(nk) || (ctx.tier === 'logs' && PII_KEYS.has(nk))) out[k] = REDACTED
        else out[k] = walk(val, depth + 1, ctx, isIdKey(k))
      }
      return out
    }
    if (Array.isArray(v)) {
      const out: unknown[] = []
      for (const e of v) {
        if (ctx.over) break
        out.push(walk(e, depth + 1, ctx, skipPhone) ?? null)
      }
      return out
    }
    const out: Record<string, unknown> = {}
    const entries = Object.entries(v as Record<string, unknown>)
    // A bare `name` is a person's name only next to contact fields or inside a `customer`
    // object; product and outlet names stay readable.
    const personName = ctx.tier === 'logs' && (isCustomer || entries.some(([k]) => CONTACT_KEYS.has(normKey(k))))
    for (const [rawKey, val] of entries) {
      if (ctx.over) break
      const k = rawKey.replace(NUL_RE, '')
      const nk = normKey(k)
      account(ctx, utf8Len(k) + KEY_OVERHEAD)
      if (SECRET_KEYS.has(nk) || (ctx.tier === 'logs' && (PII_KEYS.has(nk) || (personName && nk === 'name')))) {
        out[k] = REDACTED
        account(ctx, REDACTED.length + 2)
        continue
      }
      const r = walk(val, depth + 1, ctx, isIdKey(k), nk === 'customer', nk === 'stack' ? MAX_STACK_LOGS : MAX_STRING_LOGS)
      if (r !== undefined) out[k] = r
    }
    return out
  } finally {
    ctx.seen.delete(obj)
  }
}

function run(value: unknown, tier: RedactTier): unknown {
  const logs = tier === 'logs'
  const ctx: Ctx = {
    tier,
    maxDepth: logs ? MAX_DEPTH_LOGS : MAX_DEPTH_SECRETS,
    maxNodes: logs ? MAX_NODES_LOGS : MAX_NODES_SECRETS,
    maxBytes: logs ? MAX_TOTAL_BYTES_LOGS : 0,
    nodes: 0,
    bytes: 0,
    over: false,
    seen: new WeakSet(),
  }
  const out = walk(value, 0, ctx, false)
  return ctx.over ? { _truncated: true, bytes: ctx.bytes } : out
}

/** Secrets + PII + size caps: error logs, sync log, shared diagnostics. */
export function redactForLogs<T = unknown>(value: T): unknown {
  return run(value, 'logs')
}

/** Credentials only: review reports (head office needs the customer to resolve). */
export function redactSecrets<T = unknown>(value: T): unknown {
  return run(value, 'secrets')
}
