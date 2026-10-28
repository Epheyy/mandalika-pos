import type { components } from '@mandalika/api'
import { isCashMethod } from '@mandalika/types'

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
    if (o.status === 'refunded') continue
    // Sales are what the drawer kept: the total less what was refunded (a part-refunded order is still a sale).
    const kept = o.total - refunded
    b.totalSales += kept
    b.totalOrders += 1
    b.byMethod[o.paymentMethod] = (b.byMethod[o.paymentMethod] ?? 0) + kept
    if (isCashMethod(methods, o.paymentMethod)) b.cashSales += kept
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

