import type { LabelMap } from './types'

export const REQUISITION_STATUS = {
  draft: { label: 'Draf', tone: 'neutral' },
  submitted: { label: 'Diajukan', tone: 'warn' },
  approved: { label: 'Disetujui', tone: 'info' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  fulfilled: { label: 'Transfer Dibuat', tone: 'ok' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
} as const satisfies LabelMap<string>
