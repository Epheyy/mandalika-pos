/*
 * Sidebar count badges and what their colour means (D-71):
 *   red   = a person has to decide (Persetujuan Stok, Tinjauan Sinkron, Integrasi ERP: dokumen gagal)
 *   amber = worth checking, blocks nothing (Stok minus belum dicek, on Laporan)
 */
import type { NavId } from '../lib/router/routes'

export type BadgeTone = 'danger' | 'warn'

export interface NavBadge {
  count: number
  tone: BadgeTone
  /** Read out by screen readers; the tests find the review badge by "1 item terbuka". */
  label: string
}

export const badgeFor = (id: NavId, counts: { review: number; approval: number; oversell: number; erpDead: number }): NavBadge | null => {
  switch (id) {
    case 'reports':
      return counts.oversell > 0 ? { count: counts.oversell, tone: 'warn', label: `${counts.oversell} stok minus belum dicek` } : null
    case 'approvals':
      return counts.approval > 0 ? { count: counts.approval, tone: 'danger', label: `${counts.approval} menunggu persetujuan` } : null
    case 'syncReview':
      return counts.review > 0 ? { count: counts.review, tone: 'danger', label: `${counts.review} item terbuka` } : null
    case 'erpOutbox':
      return counts.erpDead > 0 ? { count: counts.erpDead, tone: 'danger', label: `${counts.erpDead} dokumen ERP gagal` } : null
    default:
      return null
  }
}
