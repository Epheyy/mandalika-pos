// Canonical phone normalizer: the TypeScript twin of backend/internal/phone/phone.go and the SQL
// normalize_phone() (migration 0080). Shared vectors: sync/src/__fixtures__/phone-vectors.json.
// The key is used for matching (A30 lookup, duplicate detection); never to display a number.

export const PHONE_MIN_DIGITS = 8

/** E.164 maximum, country code included. */
export const PHONE_MAX_DIGITS = 15

// The explicit set trimmed from both ends, identical in the Go and SQL twins (JavaScript's trim()
// and Go's TrimSpace disagree on U+0085 and U+FEFF): ASCII whitespace, U+0085, U+00A0, U+FEFF,
// U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
const EDGE_SPACE = /^[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

/**
 * The canonical key of a phone number, or '' when it is not a usable phone.
 * Spaces - . ( ) are stripped, then: a leading '+' or '00' is international (the digits that
 * follow are kept); a leading '0' is an Indonesian local number; a bare '8...' is an Indonesian
 * mobile missing its 0; country code 62 folds to the local 0 form, so 0812..., 62812... and
 * +62 812... are one key. Digits only, at least 8, and at most 15 counting the country code.
 */
export function normalizePhone(raw: string): string {
  let s = raw.replace(EDGE_SPACE, '').replace(/[ \-.()]/g, '')
  let intl = false
  if (s.startsWith('+')) {
    intl = true
    s = s.slice(1)
  } else if (s.startsWith('00')) {
    intl = true
    s = s.slice(2)
  }
  if (!/^[0-9]+$/.test(s)) return ''
  let key: string
  if (intl && s.startsWith('0')) return ''
  else if (s.startsWith('620')) key = '0' + s.slice(3) // +62 (0)812...: the written trunk zero
  else if (s.startsWith('62')) key = '0' + s.slice(2)
  else if (!intl && s.startsWith('0')) key = s
  else if (!intl && s.startsWith('8')) key = '0' + s
  else key = s
  if (key.length < PHONE_MIN_DIGITS) return ''
  const digits = key.startsWith('0') ? key.length + 1 : key.length // '0' stands for the 2-digit code 62
  return digits > PHONE_MAX_DIGITS ? '' : key
}
