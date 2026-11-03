import type { LabelMap } from './types'

export const TRANSFER_STATUS = {
  draft: { label: 'Draf', tone: 'neutral' },
  in_transit: { label: 'Dikirim', tone: 'warn' },
  completed: { label: 'Diterima', tone: 'ok' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
} as const satisfies LabelMap<string>
