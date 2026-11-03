import type { LabelMap } from './types'

export const ROLE = {
  admin: { label: 'Admin', tone: 'danger' },
  manager: { label: 'Manajer', tone: 'info' },
  cashier: { label: 'Kasir', tone: 'ok' },
} as const satisfies LabelMap<string>
