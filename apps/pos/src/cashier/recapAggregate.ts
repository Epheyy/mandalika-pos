import type { components } from '@mandalika/api'
import { isCashMethod } from '@mandalika/types'
import { defaultPayoutMethod } from './refundView'

type Order = components['schemas']['Order']
export type PaymentMethodCfg = { id: string; label: string; isEnabled: boolean; isCash?: boolean | null }

export interface Breakdown {
  byMethod: Record<string, number>
  totalSales: number
  totalOrders: number
  refundCount: number
  refundTotal: number
  refundItems: number
  cashSales: number
  gross: number
  discount: number
  tax: number
  surcharge: number
  net: number
}

/** C6: what an order kept, per method. A split order (or any order with real tender lines) counts each line's applied
 *  amount under its own method, less each refund under the method it was paid out in; an order without tender lines
 *  (old, local, or only the server's synthetic line) keeps its whole amount under the payment method, as before. */
const hasRealTenders = (o: Order): boolean => (o.tenders ?? []).some((t) => !t.synthetic)

function keptByMethod(o: Order, kept: number, refunded: number, methods: PaymentMethodCfg[]): Record<string, number> {
  const lines = o.tenders ?? []
  if (!hasRealTenders(o)) return { [o.paymentMethod]: kept }
  const out: Record<string, number> = {}
  for (const t of lines) out[t.method] = (out[t.method] ?? 0) + t.amount
  let unassigned = refunded
  for (const r of o.refunds ?? []) {
    const m = r.paymentMethod || o.paymentMethod
    out[m] = (out[m] ?? 0) - r.amount
    unassigned -= r.amount
  }
  // A refunded amount the refund rows do not account for (an older server) leaves through the default payout.
  if (unassigned > 0) {
    const m = defaultPayoutMethod(o, methods) ?? o.paymentMethod
    out[m] = (out[m] ?? 0) - unassigned
  }
  return out
}

export function aggregate(orders: Order[], methods: PaymentMethodCfg[]): Breakdown {
  const b: Breakdown = {
    byMethod: {}, totalSales: 0, totalOrders: 0, refundCount: 0,
    refundTotal: 0, refundItems: 0, cashSales: 0, gross: 0, discount: 0,
    tax: 0, surcharge: 0, net: 0,
  }
  for (const o of orders) {
    if (o.status === 'cancelled') continue
    // C4b: money back to customers, from the server's refund rows. A fully refunded order without the field is
    // a whole refund (older server); a part-refunded one without it is unknown, so it is not guessed.
    const refunded = o.refundedAmount ?? (o.status === 'refunded' ? o.total : 0)
    if (refunded > 0) {
      b.refundCount += 1
      b.refundTotal += refunded
      b.refundItems += o.status === 'refunded' ? o.items.reduce((s, i) => s + i.quantity, 0) : o.items.reduce((s, i) => s + (i.refundedQty ?? 0), 0)
    }
    if (o.status === 'refunded') {
      // A fully refunded order with real tender lines still moves money between methods (the server's shift
      // buckets keep it: lines less refunds by payout method), so a cash payout of a QRIS line shows in the
      // drawer. It is not a sale: totals, count and the gross/discount rows skip it, as before. Orders without
      // real lines (pre-C6, synthetic) stay out entirely, byte-identical to the old recap.
      if (hasRealTenders(o)) {
        for (const [m, v] of Object.entries(keptByMethod(o, 0, refunded, methods))) {
          if (v === 0) continue // a method that nets to zero adds no row (a whole same-method refund, as before)
          b.byMethod[m] = (b.byMethod[m] ?? 0) + v
          if (isCashMethod(methods, m)) b.cashSales += v
        }
      }
      continue
    }
    // Sales are what the drawer kept: the total less what was refunded (a part-refunded order is still a sale).
    const kept = o.total - refunded
    b.totalSales += kept
    b.totalOrders += 1
    for (const [m, v] of Object.entries(keptByMethod(o, kept, refunded, methods))) {
      b.byMethod[m] = (b.byMethod[m] ?? 0) + v
      if (isCashMethod(methods, m)) b.cashSales += v
    }
    b.gross += o.subtotal
    b.discount += o.discountAmount
    b.tax += o.taxAmount
    // Surcharge isn't a dedicated field on Order; recover it as the residual
    // between the charged total and (subtotal − discount + tax).
    const residual = o.total - (o.subtotal - o.discountAmount + o.taxAmount)
    if (residual > 0) b.surcharge += residual
  }
  b.net = b.gross - b.discount
  return b
}

