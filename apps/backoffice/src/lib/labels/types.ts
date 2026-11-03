/** Badge tone shared by every status label (maps to the semantic tokens in packages/ui-tokens). */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'promo' | 'reward'

export interface EnumLabel {
  label: string
  tone: Tone
  hint?: string
}

export type LabelMap<K extends string> = Readonly<Record<K, EnumLabel>>

const UNKNOWN_LABEL = 'Lainnya'

/** Label for an enum code. An unknown or missing code never leaks raw: it reads "Lainnya" with the code as the hint. */
export function labelOf<K extends string>(map: LabelMap<K>, code: string | null | undefined): EnumLabel {
  if (code != null && Object.prototype.hasOwnProperty.call(map, code)) return map[code as K]
  return { label: UNKNOWN_LABEL, tone: 'neutral', hint: code ?? undefined }
}
