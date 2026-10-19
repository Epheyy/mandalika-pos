import type { OfflineCapState } from '@mandalika/sync'

/** A05: after 12 h without an online contact, new sales, refunds and cash in/out lock until the
 *  tablet reconnects. Shift close stays allowed and recorded work is never touched. */
export const OFFLINE_LOCKED_MESSAGE =
  'Tablet sudah offline lebih dari 12 jam. Penjualan, refund, dan kas masuk/keluar dikunci sampai tablet tersambung ke internet. Transaksi yang sudah tercatat tetap aman dan akan dikirim otomatis.'

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
    ? `Tablet offline ${offlineHours(state)} jam. Sambungkan internet sebelum 12 jam agar penjualan tidak terkunci.`
    : null
}
