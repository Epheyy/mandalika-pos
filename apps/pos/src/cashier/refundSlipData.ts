import type { RefundSlipData } from '@mandalika/printer'
import type { components } from '@mandalika/api'
import { refundAmountForUnits } from './allocateNet'
import { buildRefundBasis, type RefundCache } from './refundSelection'
import { tenderName, type PayoutMethodCfg, type RefundPayload } from './refundView'

type Order = components['schemas']['Order']

/**
 * The REFUND slip's data, built from the refund as it is about to be queued: `payload` is the single source of the
 * lines picked, the amount paid out, the reason and the payout method, so the slip can never disagree with what was
 * saved. `cache` must be the refund memory as it was BEFORE this refund was queued (the same one `planRefundSubmit`
 * read), because each line's share depends on what was refunded earlier.
 *
 * A line's own share can differ from the payout (the last refund of an order is capped at what is left, and a
 * whole-order refund pays `order.total` while its lines carry their subtotals, before the order discount, tax and
 * rounding). Lines are printed as they are and the difference gets its own signed `adjustment` row, so no item is
 * ever shown at a price it did not have and lines + adjustment = total.
 */
export function buildRefundSlipData(i: {
  order: Order
  payload: Pick<RefundPayload, 'items' | 'refundAmount' | 'total' | 'reason' | 'paymentMethod' | 'payoutMethod'>
  cache?: RefundCache
  methods?: readonly PayoutMethodCfg[]
  cashierName: string
  at: Date
  outlet?: RefundSlipData['outlet']
}): RefundSlipData {
  const { order, payload } = i
  const basis = buildRefundBasis(order, i.cache)
  let lines: RefundSlipData['lines']
  if (payload.items && basis.kind === 'lines') {
    lines = payload.items.flatMap((it) => {
      const l = basis.lines.find((x) => x.lineNo === it.lineNo)
      return l ? [{ name: l.name, qty: it.quantity, amount: refundAmountForUnits(l.net, l.soldQty, l.refundedQty, it.quantity) }] : []
    })
  } else if (basis.kind === 'whole') {
    lines = basis.items.map((x) => ({ name: x.name, qty: x.quantity, amount: x.subtotal }))
  } else {
    lines = []
  }
  const total = payload.total
  const sum = lines.reduce((n, l) => n + l.amount, 0)
  const gap = total - sum
  return {
    orderRef: order.orderNumber,
    dateTime: i.at,
    lines,
    ...(lines.length > 0 && gap !== 0 ? { adjustment: { label: 'Penyesuaian', amount: gap } } : {}),
    total,
    payoutLabel: tenderName(payload.payoutMethod ?? payload.paymentMethod, i.methods),
    reasonLabel: payload.reason,
    cashierName: i.cashierName,
    ...(i.outlet ? { outlet: i.outlet } : {}),
  }
}

/**
 * Print the REFUND slip after the refund was queued. It must never block, delay or undo the refund: the caller does
 * not await it, it never throws, and a failure only raises a toast and an error report (`kind: 'refund_slip'`).
 * `build` runs inside the guard too, so a data problem cannot escape either.
 */
export async function printRefundSlipSafely(i: {
  isPaired: boolean
  build: () => RefundSlipData
  print: (data: RefundSlipData) => Promise<void>
  orderRef: string
  onFailure: (message: string) => void
  report: (r: { source: 'print'; kind: 'refund_slip'; action: string; message: string; outletName?: string | null }) => void
  outletName?: string | null
}): Promise<void> {
  if (!i.isPaired) return
  try {
    await i.print(i.build())
  } catch (e) {
    const message = e instanceof Error ? e.message : 'struk refund gagal dicetak'
    try {
      i.report({ source: 'print', kind: 'refund_slip', action: `Cetak struk refund ${i.orderRef}`, message, outletName: i.outletName })
      i.onFailure(`Refund tersimpan, tapi struk refund gagal dicetak: ${message}`)
    } catch { /* reporting must never fail the refund either */ }
  }
}
