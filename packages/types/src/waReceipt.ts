// WhatsApp receipt message: the TypeScript twin of backend/internal/receiptlink/template.go.
// Shared vectors: __fixtures__/wa-receipt-vectors.json (both sides read the same file).
import { normalizePhone } from './phone'

export const WA_PLACEHOLDERS = ['{pelanggan}', '{sales}', '{outlet}', '{no_order}', '{total}', '{tautan}'] as const

export const DEFAULT_WA_TEMPLATE =
  'Halo {pelanggan}, terima kasih sudah berbelanja di {outlet}.\n\nStruk digital pesanan {no_order} (total {total}):\n{tautan}\n\nBagaimana pelayanan {sales} hari ini? Mohon beri penilaian lewat tautan di atas, cukup 10 detik. Tautan berlaku 7 hari.'

export const WA_TEMPLATE_MAX_RUNES = 1000
export const WA_DIGITS_MIN = 10
export const WA_DIGITS_MAX = 15

export interface WaTemplateValues {
  customerName: string
  salesmanName: string
  outletName: string
  orderNumber: string
  total: number
  link: string
}

export const WA_SAMPLE_VALUES: WaTemplateValues = {
  customerName: 'Budi Santoso',
  salesmanName: 'Rina',
  outletName: 'Mandalika BSD',
  orderNumber: 'ORD-0001',
  total: 150000,
  link: 'https://mandalika.example/r/AbCdEfGhIjKlMnOpQrStUv',
}

const PLACEHOLDER_RE = /\{[a-z_]+\}/g

/** Whitespace and newlines collapsed to one space, trimmed. */
function clean(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ')
}

/** "Rp 150.000": dot-grouped, rounded half away from zero, "-" before "Rp" when negative. No Intl (NBSP). */
export function formatRupiahWa(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  const grouped = String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const neg = v < 0 && grouped !== '0'
  return `${neg ? '-' : ''}Rp ${grouped}`
}

/** Single pass: a value that itself contains a placeholder is never re-expanded; unknown {x} stays literal. */
export function renderWaTemplate(tpl: string, v: WaTemplateValues): string {
  const values: Record<string, string> = {
    '{pelanggan}': clean(v.customerName).split(' ')[0] || 'Kak',
    '{sales}': clean(v.salesmanName) || 'tim kami',
    '{outlet}': clean(v.outletName) || '-',
    '{no_order}': clean(v.orderNumber) || '-',
    '{total}': formatRupiahWa(v.total),
    '{tautan}': clean(v.link),
  }
  return tpl.replace(PLACEHOLDER_RE, (m) => (Object.hasOwn(values, m) ? values[m]! : m))
}

/** null when the template is usable, else a Bahasa Indonesia message. */
export function validateWaTemplate(tpl: string): string | null {
  const len = [...tpl].length
  if (len < 1) return 'Template tidak boleh kosong'
  if (len > WA_TEMPLATE_MAX_RUNES) return `Template maksimal ${WA_TEMPLATE_MAX_RUNES} karakter`
  const known = new Set<string>(WA_PLACEHOLDERS)
  for (const m of tpl.match(PLACEHOLDER_RE) ?? []) {
    if (!known.has(m)) return `Placeholder ${m} tidak dikenal`
  }
  if (!tpl.includes('{tautan}')) return 'Template wajib memuat {tautan}'
  return null
}

/** wa.me digits: normalizePhone, local leading 0 -> 62; 10-15 digits, else ''. */
export function waDigits(raw: string): string {
  const key = normalizePhone(raw)
  if (!key) return ''
  const d = key.startsWith('0') ? '62' + key.slice(1) : key
  return d.length >= WA_DIGITS_MIN && d.length <= WA_DIGITS_MAX ? d : ''
}

export function maskPhone(digits: string): string {
  return '****' + digits.slice(-4)
}

export function waUrl(digits: string, text: string): string {
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}
