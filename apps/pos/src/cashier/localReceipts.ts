import type { components } from '@mandalika/api'
import type { ReceiptData } from '@mandalika/printer'
import type { LocalReceipt } from '@mandalika/sync'
import { PAYMENT_LABELS, type LocalSaleRef, type PartialGate } from './refundView'
import { receiptFromQuote, type ReceiptSnapshot } from './receiptQuote'
import { buildRefundBasis, type RefundCache } from './refundSelection'

type Order = components['schemas']['Order']

// Pure rules behind the local receipt book (A41): the sales made on this tablet, listed from the outbox and the
// receipt archive. Receipt facts only: no customer name or phone is ever shown, searched or printed from here.

export const LOCAL_BADGE = ['Tersimpan di tablet', 'Perlu ditinjau', 'Terkirim', 'Refund tersimpan di tablet', 'Sudah direfund', 'Sebagian direfund'] as const
export type LocalBadgeLabel = (typeof LOCAL_BADGE)[number]

export function localBadge(r: Pick<LocalReceipt, 'state' | 'refundQueued' | 'refunded'>, partial?: PartialGate): { label: LocalBadgeLabel; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (r.refunded || partial?.exhausted) return { label: 'Sudah direfund', tone: 'muted' }
  if (r.refundQueued) return { label: 'Refund tersimpan di tablet', tone: 'warn' }
  if (partial?.any) return { label: 'Sebagian direfund', tone: 'warn' }
  if (r.state === 'parked') return { label: 'Perlu ditinjau', tone: 'bad' }
  if (r.state === 'queued') return { label: 'Tersimpan di tablet', tone: 'warn' }
  return { label: 'Terkirim', tone: 'ok' }
}

/** Search by receipt number only (case-insensitive fragment); a blank term lists everything. */
export function filterLocalReceipts<T extends Pick<LocalReceipt, 'orderNumber'>>(rows: readonly T[], term: string): T[] {
  const t = term.trim().toLowerCase()
  return t === '' ? [...rows] : rows.filter((r) => r.orderNumber.toLowerCase().includes(t))
}

export function localSaleRef(r: Pick<LocalReceipt, 'orderUuid' | 'serverOrderId'>): LocalSaleRef {
  return r.serverOrderId ? { orderUuid: r.orderUuid, serverOrderId: r.serverOrderId } : { orderUuid: r.orderUuid }
}

const isSnapshot = (v: unknown): v is ReceiptSnapshot => {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<ReceiptSnapshot>
  return (s.v === 1 || s.v === 2) && Array.isArray(s.lines)
}

/** The order the refund dialog shows for a local receipt. Its id is the sale uuid (the dialog's identity);
 *  the payload's real ids come from {@link localSaleRef}. Always 'completed': the refund gate decides. */
export function localReceiptOrder(r: LocalReceipt): Order {
  const snap = isSnapshot(r.receiptSnapshot) ? r.receiptSnapshot : null
  const lines = snap?.lines ?? []
  // C4b: a sale that carries per-line data lists its lines by position (lineNo) with their net share; the snapshot
  // may hold one extra trailing line, the C3 giveaway bag, which is shown but never refundable (D-41).
  const nets = r.lineNets && r.lineNets.length > 0 && lines.length >= r.lineNets.length && lines.length - r.lineNets.length <= 1 ? r.lineNets : null
  return {
    id: r.orderUuid,
    orderNumber: r.orderNumber,
    status: 'completed',
    total: r.quotedTotal ?? snap?.total ?? 0,
    paymentMethod: r.paymentMethod,
    shiftId: r.shiftId,
    createdAt: r.capturedAt,
    items: lines.map((l, i) => ({
      productId: l.productId, productName: l.name, variantSize: l.variantSize, quantity: l.qty, price: l.unitPrice, subtotal: l.amount,
      ...(l.isReward ? { isReward: true } : {}),
      ...(l.isBundle ? { isBundle: true } : {}),
      ...(nets && i < nets.length ? { lineNo: i, netAmount: nets[i], refundGroup: r.lineGroups?.[i] ?? null } : {}),
      ...(nets && i >= nets.length ? { isGiveaway: true } : {}),
    })),
  } as unknown as Order
}

/** A synced sale whose receipt carries no per-line data (archived before per-line refunds, or its allocation failed):
 *  this tablet cannot tell what is left to refund (another tablet or the backoffice may have part-refunded it), so the
 *  refund is made from Riwayat, which reads the server order. Unsynced sales and receipts with line data are unaffected. */
export function refundViaHistory(r: Pick<LocalReceipt, 'serverOrderId'>, order: Order, cache?: RefundCache): boolean {
  return !!r.serverOrderId && buildRefundBasis(order, cache).kind === 'whole'
}

/** Shown instead of a refund button when the cashier is offline and the refund must go through Riwayat. */
export const REFUND_VIA_HISTORY_OFFLINE = 'Refund struk ini lewat Riwayat saat online.'

/** The slip for a reprint from a local receipt, built from the stored A10 snapshot only. Null when there is
 *  nothing trustworthy to print (no snapshot, or no quoted total). Never touches the outbox. */
export function reprintReceiptData(r: LocalReceipt): ReceiptData | null {
  if (!isSnapshot(r.receiptSnapshot) || typeof r.quotedTotal !== 'number') return null
  return receiptFromQuote({ quotedTotal: r.quotedTotal, receiptSnapshot: r.receiptSnapshot }, {
    orderRef: r.orderNumber,
    dateTime: new Date(r.capturedAt),
    paymentLabel: PAYMENT_LABELS[r.paymentMethod] ?? r.paymentMethod,
    customerName: null,
    customerPhone: null,
    cashierName: '-',
  })
}

/** The newest local receipt that can be reprinted (the list is newest first). */
export function newestReprintable(rows: readonly LocalReceipt[]): LocalReceipt | null {
  return rows.find((r) => reprintReceiptData(r) !== null) ?? null
}
