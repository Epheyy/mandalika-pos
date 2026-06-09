// apps/backoffice/src/screens/customers/interactionTypes.ts
// Fixed interaction types (must match the backend CHECK constraint).
import { tagChipClasses } from './tagColors'

export const INTERACTION_TYPES = ['telepon', 'kunjungan', 'pesan', 'catatan'] as const
export type InteractionType = (typeof INTERACTION_TYPES)[number]

const META: Record<InteractionType, { label: string; color: string }> = {
  telepon: { label: 'Telepon', color: 'blue' },
  kunjungan: { label: 'Kunjungan', color: 'green' },
  pesan: { label: 'Pesan', color: 'purple' },
  catatan: { label: 'Catatan', color: 'gray' },
}

export const interactionLabel = (t: string): string =>
  META[t as InteractionType]?.label ?? t

export const interactionChipClasses = (t: string): string =>
  tagChipClasses(META[t as InteractionType]?.color ?? 'gray')

/** Whole days from today until a MM-DD recurrence of `dateISO`, or null. */
export function daysUntilRecurrence(dateISO?: string | null): number | null {
  if (!dateISO) return null
  const src = new Date(dateISO)
  if (Number.isNaN(src.getTime())) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let next = new Date(today.getFullYear(), src.getMonth(), src.getDate())
  if (next < today) next = new Date(today.getFullYear() + 1, src.getMonth(), src.getDate())
  return Math.round((next.getTime() - today.getTime()) / 86400000)
}
