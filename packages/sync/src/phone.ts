// Phone normalizer, twin of backend/internal/phone/phone.go and the SQL
// normalize_phone() (migration 0061). Shared vectors: __fixtures__/phone-vectors.json.
// Used only for exact-match customer lookup (A30); never to display a number.

export const PHONE_MIN_DIGITS = 8

// The explicit set trimmed from both ends, identical in the Go and SQL twins (JavaScript's trim()
// and Go's TrimSpace disagree on U+0085 and U+FEFF): ASCII whitespace, U+0085, U+00A0, U+FEFF,
// U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
const EDGE_SPACE = /^[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

/** Strip spaces - . ( ), accept one leading +, fold country code 62 to 0.
 *  Returns '' when the value is not digits-only or has fewer than 8 digits. */
export function normalizePhone(raw: string): string {
  let s = raw.replace(EDGE_SPACE, '').replace(/[ \-.()]/g, '')
  if (s.startsWith('+')) s = s.slice(1)
  if (!/^[0-9]+$/.test(s)) return ''
  if (s.startsWith('62')) s = '0' + s.slice(2)
  return s.length < PHONE_MIN_DIGITS ? '' : s
}
