import type { LabelMap } from './types'

export const ORDER_STATUS = {
  completed: { label: 'Selesai', tone: 'ok' },
  partially_refunded: { label: 'Sebagian refund', tone: 'warn' },
  refunded: { label: 'Refund', tone: 'danger' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
} as const satisfies LabelMap<string>
