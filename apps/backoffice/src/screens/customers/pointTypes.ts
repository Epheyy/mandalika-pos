import { tagChipClasses } from './tagColors'

const META: Record<string, { label: string; color: string }> = {
  earn: { label: 'Perolehan', color: 'green' },
  redeem: { label: 'Penukaran', color: 'amber' },
  adjust: { label: 'Penyesuaian', color: 'blue' },
  refund: { label: 'Refund', color: 'red' },
}

export const pointTypeLabel = (t: string): string => META[t]?.label ?? t
export const pointTypeChipClasses = (t: string): string => tagChipClasses(META[t]?.color ?? 'gray')
