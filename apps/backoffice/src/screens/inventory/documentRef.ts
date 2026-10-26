import type { StockMovementRow } from '@mandalika/api'

/** The document behind a kartu stok row, as the Dokumen cell opens it. */
export type DocRef =
  | { type: 'adjustment' | 'transfer' | 'count' | 'receipt' | 'order'; id: string; label: string }

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
      return canReadOrders && m.refId ? { type: 'order', id: m.refId, label } : null
    default:
      return null
  }
}
