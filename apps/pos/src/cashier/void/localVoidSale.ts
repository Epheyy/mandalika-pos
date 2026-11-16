import type { LocalReceipt } from '@mandalika/sync'
import type { LocalVoidSale } from './voidRules'

const isLines = (v: unknown): v is { lines: { productId: string; variantSize: string; qty: number }[] } =>
  !!v && typeof v === 'object' && Array.isArray((v as { lines?: unknown }).lines)

/** A sale made on this tablet as the void rules see it. `lines` come from the receipt snapshot, which already holds the
 *  outlet giveaway unit as its trailing Rp0 line, so no separate giveaway is passed for it. */
export function localVoidSale(r: LocalReceipt): LocalVoidSale {
  const snap = isLines(r.receiptSnapshot) ? r.receiptSnapshot : null
  const total = r.quotedTotal ?? (typeof (r.receiptSnapshot as { total?: unknown } | null)?.total === 'number' ? (r.receiptSnapshot as { total: number }).total : 0)
  return {
    orderUuid: r.orderUuid,
    ...(r.serverOrderId ? { serverOrderId: r.serverOrderId } : {}),
    orderNumber: r.orderNumber,
    total,
    shiftId: r.shiftId,
    capturedAt: r.capturedAt,
    ...(r.tenders && r.tenders.length > 0 ? { tenders: r.tenders.map((t) => ({ method: t.method, amount: t.amount, ...(t.reference ? { reference: t.reference } : {}) })) } : {}),
    paymentMethod: r.paymentMethod,
    ...(snap ? { lines: snap.lines.map((l) => ({ productId: l.productId, variantSize: l.variantSize, quantity: l.qty })) } : {}),
    refundQueued: r.refundQueued,
    refunded: r.refunded,
    voidQueued: !!r.voidQueued,
    voided: !!r.voided,
  }
}
