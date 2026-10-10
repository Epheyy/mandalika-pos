export interface CashTender {
  /** What the sale records as received. */
  amountPaid: number
  change: number
  /** A typed cash amount below the total: the sale must be blocked. */
  isShort: boolean
}

/**
 * Cash tender for a checkout. Non-cash methods are always paid exactly the total.
 * Owner rule: an empty/blank cash input means "exact total" (no change, not short);
 * a typed amount below the total is short and blocked; at or above it gives change.
 */
export function cashTender(isCash: boolean, paidInput: string, total: number): CashTender {
  if (!isCash || paidInput.trim() === '') return { amountPaid: total, change: 0, isShort: false }
  const paid = parseFloat(paidInput.replace(/\./g, ''))
  if (!Number.isFinite(paid) || paid < 0) return { amountPaid: 0, change: 0, isShort: true }
  if (paid < total) return { amountPaid: paid, change: 0, isShort: true }
  return { amountPaid: paid, change: Math.max(0, paid - total), isShort: false }
}
