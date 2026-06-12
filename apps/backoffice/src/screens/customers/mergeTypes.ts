import type { Customer } from '@mandalika/api'

export const MERGE_FIELDS = ['name', 'phone', 'email', 'birthday', 'anniversary', 'notes'] as const
export type MergeField = (typeof MERGE_FIELDS)[number]

export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  name: 'Nama', phone: 'Telepon', email: 'Email',
  birthday: 'Ulang Tahun', anniversary: 'Hari Jadi', notes: 'Catatan',
}

export interface Conflict {
  field: MergeField
  keeper: string | null
  dup: string | null
  default: 'keeper' | 'dup'
}

const norm = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

export function computeConflicts(keeper: Customer, dup: Customer): Conflict[] {
  const out: Conflict[] = []
  for (const field of MERGE_FIELDS) {
    const k = norm((keeper as Record<string, unknown>)[field])
    const d = norm((dup as Record<string, unknown>)[field])
    if (k === d) continue
    out.push({ field, keeper: k, dup: d, default: k === null && d !== null ? 'dup' : 'keeper' })
  }
  return out
}
