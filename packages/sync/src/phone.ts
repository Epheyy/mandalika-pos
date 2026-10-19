// Phone normalizer, twin of backend/internal/phone/phone.go and the SQL
// normalize_phone() (migration 0061). Shared vectors: __fixtures__/phone-vectors.json.
// Used only for exact-match customer lookup (A30); never to display a number.

export const PHONE_MIN_DIGITS = 8

/** Strip spaces - . ( ), accept one leading +, fold country code 62 to 0.
 *  Returns '' when the value is not digits-only or has fewer than 8 digits. */
export function normalizePhone(raw: string): string {
  let s = raw.trim().replace(/[ \-.()]/g, '')
  if (s.startsWith('+')) s = s.slice(1)
  if (!/^[0-9]+$/.test(s)) return ''
  if (s.startsWith('62')) s = '0' + s.slice(2)
  return s.length < PHONE_MIN_DIGITS ? '' : s
}
