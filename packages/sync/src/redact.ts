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
  'authorization', 'cookie', 'secret', 'apikey', 'passwd', 'clientsecret',
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

// ASCII whitespace classes (not \s) and ASCII-only case folding (ci() spells out [bB] classes
// instead of the i flag, whose Unicode folding differs between JS and Go) so the Go twin
// matches exactly. Quantifiers are bounded (RE2 allows at most 1000).
const ci = (lit: string): string => lit.replace(/[a-z]/gi, (c) => '[' + c.toLowerCase() + c.toUpperCase() + ']')
const BEARER_RE = new RegExp(ci('Bearer') + '[ \\t\\r\\n]+[A-Za-z0-9._~+/=-]+', 'g')
const BASIC_RE = new RegExp('(' + ci('Authorization:') + '[ \\t]*)' + ci('Basic') + '[ \\t]+[A-Za-z0-9+/]+={0,2}', 'g')
const URL_SECRET_RE = new RegExp(
  '((?:^|[?&,;( \\t\\r\\n])(?:' + ['token', 'access_token', 'key', 'sig', 'password', 'pin', 'api_key', 'apikey'].map(ci).join('|') + ')=)[^& \\t\\r\\n#]*',
  'g',
)
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g
const NUL_RE = /\0/g

/** Credential keys: exact names plus anything containing pinhash (receivePinHash, pin_hash...). */
const isSecretKey = (nk: string): boolean => SECRET_KEYS.has(nk) || nk.includes('pinhash')

/** Lower-case ASCII letters only (toLowerCase folds non-ASCII differently from Go). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

function normKey(k: string): string {
  return asciiLower(k).replace(/[_-]/g, '')
}

function isIdKey(k: string): boolean {
  const lower = asciiLower(k)
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
const isB64 = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-'
// Separators a phone number may be written with: space-like, dash-like, '.', '/', parens, '_'.
const SPACE_LIKE = new Set([' ', '\t', ' ', ' ', ' '])
const DASH_LIKE = new Set(['-', '–', '—', '‑', '−'])
const PHONE_SEPS = new Set([...SPACE_LIKE, ...DASH_LIKE, '.', '/', '(', ')', '_'])

/** Length of the separator unit at j: " - " (space, dash, space) is ONE unit; 0 if none. */
function sepLen(s: string, j: number): number {
  const c = s[j]
  if (c === undefined) return 0
  if (SPACE_LIKE.has(c) && j + 2 < s.length && DASH_LIKE.has(s[j + 1]) && SPACE_LIKE.has(s[j + 2])) return 3
  return PHONE_SEPS.has(c) ? 1 : 0
}

const PHONE_LOOKAHEAD = 40 // characters examined per candidate: keeps the scan linear
const PHONE_CHAIN_LOOKAHEAD = 80
const PHONE_MIN_NATIONAL = 9
const PHONE_MAX_NATIONAL = 12
const CODE_CHAIN_DIGITS = 20

/**
 * The span [begin, end) of an Indonesian phone number starting at the token boundary i, or null.
 * FAIL CLOSED: a prefix (0 directly before the 8; or 62, +62 or 0062 with up to three separator
 * units before the 8 and an optional trunk 0 or (0) in between) then digits and separators (at
 * most two separator units in a row, no minimum group size) until the national digits (from the
 * 8) reach 12; the LONGEST prefix ending on a digit with 9..12 national digits is taken.
 * Exception: a '-'/'.' joined chain of 20+ digits whose candidate would end inside it is a
 * barcode-like code and stays. The Go twin implements the same scanner.
 */
function phoneSpanAt(s: string, i: number): [number, number] | null {
  const n = s.length
  let begin = i
  let q: number
  let closeSeen = false
  let pfx = 0
  if (s.startsWith('0062', i)) pfx = 4
  else if (s[i] === '6' && s[i + 1] === '2') pfx = 2
  if (pfx > 0) {
    q = i + pfx
    if (pfx === 2 && i > 0 && s[i - 1] === '+') begin = i - 1
    const skipSeps = (max: number): void => {
      for (let units = 0; units < max; units++) {
        const len = sepLen(s, q)
        if (len === 0) return
        if (len === 1 && s[q] === ')') closeSeen = true
        q += len
      }
    }
    skipSeps(3)
    if (s[q] === '0') { q++; skipSeps(2) }
  } else if (s[i] === '0' && s[i + 1] === '8' && i + 2 < n && isDigit(s[i + 2])) {
    q = i + 1
  } else {
    return null
  }
  if (s[q] !== '8') return null
  let nd = 0
  let validEnd = -1
  let validClose = false
  let sepRun = 0
  const limit = Math.min(n, i + PHONE_LOOKAHEAD)
  for (let j = q; j < limit;) {
    const c = s[j]
    if (isDigit(c)) {
      nd++
      if (nd > PHONE_MAX_NATIONAL) break
      sepRun = 0
      j++
      if (nd >= PHONE_MIN_NATIONAL) {
        validEnd = j
        validClose = closeSeen
      }
      continue
    }
    const len = sepLen(s, j)
    if (len === 0 || ++sepRun > 2) break
    if (len === 1 && c === ')') closeSeen = true
    j += len
  }
  if (validEnd < 0) return null
  // Barcode-like chain: 20+ digits joined by single '-' or '.', candidate ends inside it.
  let digits = 0
  let k = i
  const chainLimit = Math.min(n, i + PHONE_CHAIN_LOOKAHEAD)
  while (k < chainLimit) {
    if (isDigit(s[k])) { digits++; k++ }
    else if ((s[k] === '-' || s[k] === '.') && k > i && k + 1 < n && isDigit(s[k + 1])) k++
    else break
  }
  if (digits >= CODE_CHAIN_DIGITS && validEnd < k) return null
  let end = validEnd
  if (begin > 0 && s[begin - 1] === '(') {
    if (validClose) begin--
    else if (end < n && s[end] === ')') { begin--; end++ }
  }
  return [begin, end]
}

/** Redact the UNION of every phone span (candidates at every token boundary), merging touching ones. */
function redactPhones(s: string): string {
  const n = s.length
  let out = ''
  let last = 0
  let curB = -1
  let curE = -1
  for (let i = 0; i < n; i++) {
    if (!isDigit(s[i]) || (i > 0 && isDigit(s[i - 1]))) continue
    const span = phoneSpanAt(s, i)
    if (!span) continue
    if (curB >= 0 && span[0] <= curE) {
      curB = Math.min(curB, span[0])
      curE = Math.max(curE, span[1])
    } else {
      if (curB >= 0) { out += s.slice(last, curB) + REDACTED; last = curE }
      curB = span[0]
      curE = span[1]
    }
  }
  if (curB >= 0) { out += s.slice(last, curB) + REDACTED; last = curE }
  return out + s.slice(last)
}

/** JWTs (two or three base64url segments starting eyJ), one linear pass. */
function redactJwts(s: string): string {
  const n = s.length
  let out = ''
  let last = 0
  let from = 0
  for (;;) {
    const st = s.indexOf('eyJ', from)
    if (st < 0) break
    let p = st + 3
    while (p < n && isB64(s[p])) p++
    if (p === st + 3 || p >= n || s[p] !== '.') { from = Math.max(p, st + 3); continue }
    let q = p + 1
    while (q < n && isB64(s[q])) q++
    if (q === p + 1) { from = q; continue }
    let end = q
    if (q < n && s[q] === '.') {
      end = q + 1
      while (end < n && isB64(s[end])) end++
    }
    out += s.slice(last, st) + REDACTED
    last = end
    from = end
  }
  return out + s.slice(last)
}

/** Backslashes directly before s[i], not looking before `floor`. */
function backslashesBefore(s: string, i: number, floor: number): number {
  let r = 0
  while (i - 1 - r >= floor && s[i - 1 - r] === '\\') r++
  return r
}

/**
 * Where the value after a secret key's colon ends (exclusive), starting at pos. `keyEscapes` is the
 * number of backslashes before the key's quotes (0 = plain JSON, 1 = JSON inside a JSON string,
 * 3 = twice nested, 7 = three times): string literals inside the value are then delimited by that
 * many backslashes plus the quote. Object/array values end at their matching bracket, ignoring
 * brackets inside string literals. Unterminated values run to the end of the string.
 */
function jsonValueEnd(s: string, pos: number, keyEscapes: number): number {
  const n = s.length
  if (pos >= n) return pos
  const isDelimiter = (i: number, floor: number, k: number): boolean => {
    const r = backslashesBefore(s, i, floor)
    return k === 0 ? r % 2 === 0 : r === k
  }
  const c = s[pos]
  if (c === '{' || c === '[') {
    let depth = 0
    let inStr = false
    for (let i = pos; i < n; i++) {
      const d = s[i]
      if (d === '"') {
        if (isDelimiter(i, pos, keyEscapes)) inStr = !inStr
      } else if (!inStr) {
        if (d === '{' || d === '[') depth++
        else if ((d === '}' || d === ']') && --depth === 0) return i + 1
      }
    }
    return n
  }
  let k = 0
  while (pos + k < n && s[pos + k] === '\\') k++
  if (pos + k < n && s[pos + k] === '"') {
    for (let i = pos + k + 1; i < n; i++) {
      if (s[i] === '"' && isDelimiter(i, pos + k + 1, k)) return i + 1
    }
    return n
  }
  let e = pos
  while (e < n && !',}] \t\r\n"\\'.includes(s[e])) e++
  return e
}

// Key + colon of a secret entry inside a string that holds JSON, escaped up to three levels
// (up to 7 backslashes before a quote). ASCII-only case folding via ci().
const JSON_KEY_RE = new RegExp(
  '(\\\\{0,7})"(' +
    ['[A-Za-z0-9_-]{0,40}' + ci('pin') + '[_-]?' + ci('hash') + '[A-Za-z0-9_-]{0,40}', ci('pin'), ci('passwd'), ci('password'), ci('token'),
      ci('access') + '[_-]?' + ci('token'), ci('refresh') + '[_-]?' + ci('token'), ci('authorization'), ci('cookie'), ci('secret'),
      ci('client') + '[_-]?' + ci('secret'), ci('api') + '[_-]?' + ci('key'), ci('apikey')].join('|') +
    ')(\\\\{0,7})"[ \\t\\r\\n]*:[ \\t\\r\\n]*',
  'g',
)

function redactJsonSecrets(s: string): string {
  let out = ''
  let last = 0
  JSON_KEY_RE.lastIndex = 0
  for (;;) {
    const m = JSON_KEY_RE.exec(s)
    if (!m) break
    const valStart = m.index + m[0].length
    const end = jsonValueEnd(s, valStart, m[1].length)
    if (end <= valStart) { JSON_KEY_RE.lastIndex = valStart; continue }
    out += s.slice(last, m.index) + `"${m[2]}":"${REDACTED}"`
    last = end
    JSON_KEY_RE.lastIndex = end
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
  out = redactJsonSecrets(redactJwts(out
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(BASIC_RE, `$1Basic ${REDACTED}`)))
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
        if (isSecretKey(nk) || (ctx.tier === 'logs' && PII_KEYS.has(nk))) out[k] = REDACTED
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
      if (isSecretKey(nk) || (ctx.tier === 'logs' && (PII_KEYS.has(nk) || (personName && nk === 'name')))) {
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
