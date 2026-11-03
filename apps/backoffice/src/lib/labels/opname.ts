import type { LabelMap } from './types'

export const OPNAME_STATUS = {
  planned: { label: 'Direncanakan', tone: 'neutral' },
  in_progress: { label: 'Sedang Berjalan', tone: 'info' },
  pending_approval: { label: 'Menunggu Persetujuan', tone: 'warn' },
  completed: { label: 'Selesai', tone: 'ok' },
  cancelled: { label: 'Dibatalkan', tone: 'danger' },
} as const satisfies LabelMap<string>
