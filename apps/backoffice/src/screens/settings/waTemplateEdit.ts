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
export function insertAtCursor(text: string, start: number, end: number, token: string): InsertResult {
  const s = Math.min(Math.max(0, start), text.length)
  const e = Math.min(Math.max(s, end), text.length)
  return { text: text.slice(0, s) + token + text.slice(e), caret: s + token.length }
}

/** Characters the way the server counts them (runes). */
export const templateLength = (tpl: string): number => [...tpl].length

/** Save is allowed only for a valid template that differs from the saved one. */
export function canSaveTemplate(draft: string, saved: string): boolean {
  return draft !== saved && validateWaTemplate(draft) === null
}
