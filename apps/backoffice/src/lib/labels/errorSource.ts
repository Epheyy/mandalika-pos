import type { LabelMap } from './types'

export const ERROR_SOURCE = {
  sync: { label: 'Sync', tone: 'warn' },
  runtime: { label: 'Runtime', tone: 'danger' },
  print: { label: 'Cetak', tone: 'neutral' },
  backend: { label: 'Backend', tone: 'info' },
} as const satisfies LabelMap<string>
