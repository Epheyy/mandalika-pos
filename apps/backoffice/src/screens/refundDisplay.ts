import type { components } from '@mandalika/api'

type Shift = components['schemas']['Shift']
type Order = components['schemas']['Order']

/** Shift report column: refunds this shift paid out in cash for sales of other shifts (A06). */
export const CASH_REFUNDS_PAID_HEADER = 'Refund dibayar (Tunai)'

/** Table cell (pass a formatter) or CSV value (no formatter). null/undefined (a shift closed before
 *  migration 0047, or an older server) shows "—", never a made-up zero. */
export function cashRefundsPaidCell(s: Pick<Shift, 'cashRefundsPaid'>, format?: (n: number) => string): string | number {
  const v = s.cashRefundsPaid
  if (typeof v !== 'number') return '—'
  return format ? format(v) : v
}

/** "oleh {name}" for a refunded order whose refunder was recorded; null for older refunds. */
export function refundedByLine(o: Pick<Order, 'refundedByName'>): string | null {
  const name = o.refundedByName?.trim()
  return name ? `oleh ${name}` : null
}
