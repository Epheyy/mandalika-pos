import type { LabelMap } from './types'

/** Known sync-review reasons; reviewLabels.ts keeps the "Ditolak (code)" fallback for the rest. */
export const SYNC_REVIEW_REASON = {
  forbidden: { label: 'Ditolak: tidak berwenang / PIN salah', tone: 'danger' },
  actor_mismatch: { label: 'Dibuat oleh akun lain', tone: 'danger' },
  offline_expired: { label: 'Offline lebih dari 12 jam', tone: 'danger' },
  competing_receipt: { label: 'Transfer sudah diterima tablet lain', tone: 'danger' },
  rejected: { label: 'Ditolak server', tone: 'danger' },
  conflict: { label: 'Ditolak server', tone: 'danger' },
  batch_rejected: { label: 'Kiriman ditolak', tone: 'danger' },
  sale_in_review: { label: 'Penjualan asal refund sedang ditinjau', tone: 'warn' },
} as const satisfies LabelMap<string>
