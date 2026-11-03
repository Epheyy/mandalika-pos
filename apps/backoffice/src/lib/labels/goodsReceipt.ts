import type { LabelMap } from './types'

/** Why stock came in: a supplier delivery or a warranty replacement (the "Garansi" tag). */
export const GOODS_RECEIPT_SOURCE = {
  supply: { label: 'Pasokan', tone: 'neutral' },
  warranty: { label: 'Garansi', tone: 'info', hint: 'Penggantian garansi' },
} as const satisfies LabelMap<string>
