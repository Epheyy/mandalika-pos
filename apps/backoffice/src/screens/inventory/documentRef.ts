import type { StockMovementRow } from '@mandalika/api'

/** The document behind a kartu stok row, as the Dokumen cell opens it. */
export type DocRef =
  | { type: 'adjustment' | 'transfer' | 'count' | 'receipt' | 'order'; id: string; label: string }
  /** A refund ledger row: id is the ORDER id; seq picks the refund inside order.refunds. */
  | { type: 'refund'; id: string; seq: number | null; label: string }

/** "Refund ke-N" for a refund row (legacy whole-order refunds are seq 1); the order number
 *  and plain "Refund" are the fallbacks when the server could not resolve the refund row. */
export function refundLabel(m: Pick<StockMovementRow, 'refundSeq' | 'refNumber'>): string {
  return m.refundSeq ? `Refund ke-${m.refundSeq}` : 'Refund'
}

/** Which ledger ref types open which document. A direct adjustment (no request), an opening
 *  backfill and an order the user may not read stay plain text. */
export function docRefOf(m: StockMovementRow, canReadOrders: boolean): DocRef | null {
  const label = m.docNumber ?? m.refNumber ?? m.refType
  switch (m.refType) {
    case 'stock_adjustment':
      return m.requestId ? { type: 'adjustment', id: m.requestId, label } : null
    case 'transfer':
      return m.refId ? { type: 'transfer', id: m.refId, label } : null
    case 'stock_count':
      return m.refId ? { type: 'count', id: m.refId, label } : null
    case 'goods_receipt':
      return m.refId ? { type: 'receipt', id: m.refId, label } : null
    case 'order':
      if (m.kind === 'refund') return canReadOrders && m.refId ? { type: 'refund', id: m.refId, seq: m.refundSeq ?? null, label: refundLabel(m) } : null
      return canReadOrders && m.refId ? { type: 'order', id: m.refId, label } : null
    default:
      return null
  }
}
