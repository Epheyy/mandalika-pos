import type { LabelMap } from './types'

/** Status the discount-code report derives per code. The server already sends Indonesian words; this gives them a tone and a stable case. */
export const DISCOUNT_CODE_STATUS = {
  aktif: { label: 'Aktif', tone: 'ok' },
  'kuota habis': { label: 'Kuota habis', tone: 'warn' },
  kedaluwarsa: { label: 'Kedaluwarsa', tone: 'neutral' },
  nonaktif: { label: 'Nonaktif', tone: 'neutral' },
} as const satisfies LabelMap<string>
