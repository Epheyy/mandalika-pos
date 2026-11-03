import type { LabelMap } from './types'

/** Built-in ids only; configured methods stay dynamic via methodLabel() in lib/splitPayment. */
export const PAYMENT_METHOD = {
  cash: { label: 'Tunai', tone: 'neutral' },
  split: { label: 'Split-Payment', tone: 'neutral' },
} as const satisfies LabelMap<string>
