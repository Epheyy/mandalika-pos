import type { StockRequisition } from '@mandalika/api'

import { badgeTone, type BadgeToneName } from '../../lib/labels/badgeTone'
import { REQUISITION_STATUS as REQUISITION_LABELS } from '../../lib/labels/requisition'

export type RequisitionStatus = StockRequisition['status']

/** Label + Badge tone per status, derived from the shared label map. */
export const REQUISITION_STATUS = Object.fromEntries(
  Object.entries(REQUISITION_LABELS).map(([k, v]) => [k, { label: v.label, tone: badgeTone(v.tone) }]),
) as Record<RequisitionStatus, { label: string; tone: BadgeToneName }>

/** The happy path, left to right. rejected / cancelled leave it and are shown as a dead end. */
export const REQUISITION_CHAIN: RequisitionStatus[] = ['draft', 'submitted', 'approved', 'fulfilled']

/** Index of the current step on the happy path; -1 for a dead-end status. */
export function chainIndex(status: RequisitionStatus): number {
  return REQUISITION_CHAIN.indexOf(status)
}

export const EVENT_LABEL: Record<string, string> = {
  created: 'Dibuat',
  updated: 'Diubah',
  submitted: 'Diajukan',
  approved: 'Disetujui',
  rejected: 'Ditolak',
  cancelled: 'Dibatalkan',
  fulfilled: 'Transfer dibuat',
  refulfilled: 'Transfer dibuat ulang',
}

export const fmtDateTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

/** Whether the linked transfer was cancelled, so the warehouse may press "Buat Transfer" again. */
export function canRefulfil(pb: Pick<StockRequisition, 'status' | 'transfer'>): boolean {
  return pb.status === 'fulfilled' && pb.transfer?.status === 'cancelled'
}
