import type { Shift } from '@mandalika/api'

/** Shown beside a shift opened offline with a negative opening cash (the sync route accepts it as sent). */
export const NEGATIVE_STARTING_CASH_BADGE = 'Kas awal negatif'
export const NEGATIVE_STARTING_CASH_HINT = 'Shift ini dibuka offline dengan kas awal di bawah nol. Angka disimpan apa adanya; mohon dicek.'

/** The review badge text for a shift, or null when there is nothing to review. */
export function startingCashBadge(s: Pick<Shift, 'startingCashWarning'>): string | null {
  return s.startingCashWarning === true ? NEGATIVE_STARTING_CASH_BADGE : null
}
