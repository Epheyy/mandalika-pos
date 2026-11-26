import type { RefundSlipData } from '@mandalika/printer'
import type { CrossOutletRefundResult } from '@mandalika/api'
import { refundSummaries, tenderName, type PayoutMethodCfg } from '../refundView'

/** The slip of a cross-outlet return, built from the refund row the server KEPT (a replay returns the earlier refund,
 *  whatever the retry selected). The header outlet is the returning outlet; "Transaksi asal" names the sale outlet. */
export function buildCrossOutletSlipData(i: {
  result: CrossOutletRefundResult
  methods?: readonly PayoutMethodCfg[]
  cashierName: string
  at: Date
  outlet?: RefundSlipData['outlet']
}): RefundSlipData {
  const { refund, order: co } = i.result
  const summary = refundSummaries({ items: co.order.items, refunds: [refund] })[0]
  const lines = (summary?.lines ?? []).map((l) => ({ name: l.name, qty: l.quantity, amount: l.amount }))
  const gap = refund.amount - lines.reduce((n, l) => n + l.amount, 0)
  return {
    orderRef: co.order.orderNumber,
    dateTime: i.at,
    lines,
    ...(lines.length > 0 && gap !== 0 ? { adjustment: { label: 'Penyesuaian', amount: gap } } : {}),
    total: refund.amount,
    payoutLabel: tenderName(refund.paymentMethod, i.methods),
    reasonLabel: refund.reason,
    cashierName: i.cashierName,
    ...(i.outlet ? { outlet: i.outlet } : {}),
    originOutlet: co.outletName,
  }
}
