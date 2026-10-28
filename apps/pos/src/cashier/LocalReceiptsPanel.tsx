/**
 * "Struk di tablet ini" (A41): the sales made on THIS tablet, from the outbox and the local receipt archive.
 * Works offline. Receipt facts only (no customer name or phone); search by receipt number only. Reprint
 * never queues anything; a refund goes through the same refund gate and dialog as the history panel.
 */
import { useState } from 'react'
import type { LocalReceipt } from '@mandalika/sync'
import { formatRupiah } from './pricing'
import { RefundAction } from './RefundAction'
import { PAYMENT_LABELS, partialGateFor, type RefundAvailabilityInput } from './refundView'
import type { RefundCache } from './refundSelection'
import { REFUND_VIA_HISTORY_OFFLINE, filterLocalReceipts, localBadge, localReceiptOrder, localSaleRef, refundViaHistory, reprintReceiptData } from './localReceipts'
import { Sheet } from '../components/ui/Sheet'

type Gate = Pick<RefundAvailabilityInput, 'canRefund' | 'hasOpenShift' | 'shiftUnsynced' | 'syncedRefundOrderIds' | 'queuedSaleUuids' | 'serverIdToSaleUuid'>

/** The same props refundGateProps hands the history panel. */
interface LocalReceiptsPanelProps extends Gate {
  queuedRefundOrderIds: ReadonlySet<string>
  /** C4b: units and money this tablet saw acknowledged for earlier per-line refunds of a sale. */
  refundCache?: (ids: readonly string[]) => RefundCache
  isOpen: boolean
  onClose: () => void
  receipts: readonly LocalReceipt[]
  /** A printer is paired. */
  canReprint: boolean
  onReprint: (r: LocalReceipt) => void
  onRefund: (r: LocalReceipt) => void
  /** Open Riwayat on this sale's server order (a synced receipt without line data is refunded from there). */
  onOpenInHistory?: (r: LocalReceipt) => void
  /** The tablet can reach the server; absent = online. */
  isOnline?: boolean
}

const TONES = {
  ok: 'bg-green-100 text-green-700',
  warn: 'bg-amber-100 text-amber-800',
  bad: 'bg-red-100 text-red-700',
  muted: 'bg-gray-100 text-gray-500',
} as const

export function LocalReceiptsPanel({ isOpen, onClose, receipts, canReprint, onReprint, onRefund, onOpenInHistory, isOnline = true, queuedRefundOrderIds, refundCache, ...gate }: LocalReceiptsPanelProps) {
  const [search, setSearch] = useState('')
  if (!isOpen) return null
  const rows = filterLocalReceipts(receipts, search)
  return (
    <Sheet open variant="center" maxWidth="max-w-2xl" panelClassName="max-h-[90vh] flex flex-col" testId="local-receipts">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h3 className="font-bold text-gray-900">Struk di tablet ini</h3>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Tutup">✕</button>
        </div>
        <div className="px-5 py-3 border-b border-gray-100 flex-shrink-0">
          <label htmlFor="local-receipt-search" className="block text-[10px] text-gray-500 font-semibold mb-1">Cari nomor struk</label>
          <input id="local-receipt-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="mis. BSD-G0007"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400" />
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {rows.length === 0 && <p className="text-center text-sm text-gray-400 py-8">Belum ada struk di tablet ini</p>}
          {rows.map((r) => {
            const order = localReceiptOrder(r)
            const cache = refundCache?.([r.orderUuid, ...(r.serverOrderId ? [r.serverOrderId] : [])])
            const badge = localBadge(r, partialGateFor(order, cache))
            return (
              <div key={r.orderUuid} className="border border-gray-100 rounded-xl p-3" data-testid="local-receipt-row">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm text-gray-900">{r.orderNumber}</p>
                    <p className="text-[11px] text-gray-500">
                      {new Date(r.capturedAt).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {' · '}{PAYMENT_LABELS[r.paymentMethod] ?? r.paymentMethod}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-sm">{formatRupiah(r.quotedTotal ?? 0)}</p>
                    <span className={`inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${TONES[badge.tone]}`}>{badge.label}</span>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <button type="button" onClick={() => onReprint(r)} disabled={!canReprint || reprintReceiptData(r) === null}
                    className="flex-1 py-2 border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                    Cetak Ulang
                  </button>
                </div>
                <RefundAction order={order} sale={localSaleRef(r)} queuedOrderIds={queuedRefundOrderIds} refundCache={refundCache} {...gate} onRefund={() => onRefund(r)}
                  viaHistory={onOpenInHistory && refundViaHistory(r, order, cache) ? { online: isOnline, onOpen: () => onOpenInHistory(r), offlineMessage: REFUND_VIA_HISTORY_OFFLINE } : undefined} />
              </div>
            )
          })}
        </div>
    </Sheet>
  )
}
