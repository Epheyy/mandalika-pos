import { WA_TEMPLATE_MAX_RUNES, validateWaTemplate } from '@mandalika/types'

export { WA_TEMPLATE_MAX_RUNES }

/** Hint shown beside each placeholder chip. */
export const WA_PLACEHOLDER_HINTS: ReadonlyArray<{ token: string; hint: string }> = [
  { token: '{pelanggan}', hint: 'Nama depan pelanggan' },
  { token: '{sales}', hint: 'Nama sales' },
  { token: '{outlet}', hint: 'Nama outlet' },
  { token: '{no_order}', hint: 'Nomor order' },
  { token: '{total}', hint: 'Total belanja' },
  { token: '{tautan}', hint: 'Tautan struk & penilaian' },
]

export interface InsertResult {
  text: string
  /** Caret position right after the inserted token. */
  caret: number
}

/** Insert a token over the selection [start, end) (clamped); the caret lands after it. */
export function insertAtCursor(input: unknown, start: number, end: number, token: string): InsertResult {
  const text = typeof input === 'string' ? input : ''
  const s = Math.min(Math.max(0, start), text.length)
  const e = Math.min(Math.max(s, end), text.length)
  return { text: text.slice(0, s) + token + text.slice(e), caret: s + token.length }
}

/** Characters the way the server counts them (runes). */
export const templateLength = (tpl: unknown): number => (typeof tpl === 'string' ? [...tpl].length : 0)

/** validateWaTemplate that never throws: a non-string is reported as empty. */
export const templateError = (tpl: unknown): string | null =>
  validateWaTemplate(typeof tpl === 'string' ? tpl : '')

/** Template payload as the card needs it; null when the response has the wrong shape. */
export interface WaTemplateInfo {
  template: string
  defaultTemplate: string
  placeholders: string[]
}

export function parseWaTemplate(raw: unknown): WaTemplateInfo | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.template !== 'string' || typeof r.defaultTemplate !== 'string') return null
  if (!Array.isArray(r.placeholders) || !r.placeholders.every((p) => typeof p === 'string')) return null
  return { template: r.template, defaultTemplate: r.defaultTemplate, placeholders: r.placeholders as string[] }
}

/** Save is allowed only for a valid template that differs from the saved one. */
export function canSaveTemplate(draft: unknown, saved: unknown): boolean {
  return typeof draft === 'string' && draft !== saved && validateWaTemplate(draft) === null
}
