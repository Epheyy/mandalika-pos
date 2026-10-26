import type { OfflineCapState } from '@mandalika/sync'

/** A05: after 12 h without an online contact, new sales, refunds and cash in/out lock until the
 *  tablet reconnects. Shift close stays allowed and recorded work is never touched. */
export const OFFLINE_LOCKED_MESSAGE =
  'Tablet offline lebih dari 12 jam. Penjualan dikunci sampai online. Transaksi yang ada tetap aman.'

const HOUR_MS = 3_600_000

/** Whole hours offline, for the chip and the warning. */
export function offlineHours(state: Pick<OfflineCapState, 'offlineMs'>): number {
  return Math.floor((state.offlineMs ?? 0) / HOUR_MS)
}

/** The refusal text when the tablet is locked, else null (proceed). */
export function offlineLockMessage(state: OfflineCapState): string | null {
  return state.level === 'locked' ? OFFLINE_LOCKED_MESSAGE : null
}

/** The nudge shown from 10 h, else null. */
export function offlineWarnMessage(state: OfflineCapState): string | null {
  return state.level === 'warn'
    ? 'Offline hampir 12 jam. Sambungkan internet agar penjualan tidak terkunci.'
    : null
}
