import type { InventoryReasonCode } from '@mandalika/api'
import type { LabelMap } from './types'

/** Insertion order is the display order of the reason selects. */
export const REASON_CODE = {
  damaged: { label: 'Rusak', tone: 'neutral' },
  expired: { label: 'Kedaluwarsa', tone: 'neutral' },
  lost: { label: 'Hilang', tone: 'neutral' },
  found: { label: 'Ditemukan', tone: 'neutral' },
  data_entry: { label: 'Salah input', tone: 'neutral' },
  tester_sample: { label: 'Tester/sampel', tone: 'neutral' },
  count_variance: { label: 'Selisih opname', tone: 'neutral' },
  other: { label: 'Lainnya', tone: 'neutral' },
} as const satisfies LabelMap<InventoryReasonCode>
