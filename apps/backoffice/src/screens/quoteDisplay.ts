import type { components } from '@mandalika/api'

type Order = components['schemas']['Order']

/** Tooltip for the "Struk" badge (A10): the cashier's quoted total vs the server's. */
export function quoteWarningTitle(
  o: Pick<Order, 'quotedTotal' | 'total' | 'quoteWarningReason'>,
  format: (n: number) => string,
): string | undefined {
  if (o.quoteWarningReason === 'quote_mismatch' && typeof o.quotedTotal === 'number') {
    const diff = o.quotedTotal - o.total
    return `Total di struk ${format(o.quotedTotal)}, total server ${format(o.total)} (selisih ${diff < 0 ? '-' : '+'}${format(Math.abs(diff))})`
  }
  if (o.quoteWarningReason === 'quote_invalid') return 'Total struk dari kasir tidak valid, dipakai total server'
  return o.quoteWarningReason ?? undefined
}

/** "Total di struk" for the expanded row: only a real quote that was flagged as different. */
export function receiptTotalLine(
  o: Pick<Order, 'quotedTotal' | 'total' | 'quoteWarning'>,
  format: (n: number) => string,
): string | null {
  if (!o.quoteWarning || typeof o.quotedTotal !== 'number' || o.quotedTotal === o.total) return null
  return format(o.quotedTotal)
}
