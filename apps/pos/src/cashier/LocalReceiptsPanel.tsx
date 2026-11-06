/**
 * "Struk di tablet ini" (A41): the sales made on THIS tablet, from the outbox and the local receipt archive.
 * Works offline. Receipt facts only (no customer name or phone); search by receipt number only. Reprint
 * never queues anything; a refund goes through the same refund gate and dialog as the history panel.
 */
import { useState } from 'react'
import type { LocalReceipt } from '@mandalika/sync'
import { formatRupiah } from './pricing'
import { RefundAction } from './RefundAction'
import { PAYMENT_LABELS, partialGateFor, tenderLineText, visibleTenders, type PayoutMethodCfg, type RefundAvailabilityInput } from './refundView'
import type { RefundCache } from './refundSelection'
import { REFUND_VIA_HISTORY_OFFLINE, filterLocalReceipts, localBadge, localReceiptOrder, localSaleRef, refundViaHistory, reprintReceiptData } from './localReceipts'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import type { Tone } from '../components/ui/tone'
import { formatHistoryStamp } from './historyStamp'

type Gate = Pick<RefundAvailabilityInput, 'canRefund' | 'hasOpenShift' | 'shiftUnsynced' | 'syncedRefundOrderIds' | 'queuedSaleUuids' | 'serverIdToSaleUuid'>

/** The same props refundGateProps hands the history panel. */
interface LocalReceiptsPanelProps extends Gate {
  queuedRefundOrderIds: ReadonlySet<string>
  /** C4b: units and money this tablet saw acknowledged for earlier per-line refunds of a sale. */
  refundCache?: (ids: readonly string[]) => RefundCache
  /** The configured payment methods, to name the lines of a split sale. Optional. */
  paymentMethods?: readonly PayoutMethodCfg[]
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

const TONES: Record<'ok' | 'warn' | 'bad' | 'muted', Tone> = { ok: 'ok', warn: 'warn', bad: 'danger', muted: 'neutral' }

export function LocalReceiptsPanel({ isOpen, onClose, receipts, canReprint, onReprint, onRefund, onOpenInHistory, isOnline = true, paymentMethods, queuedRefundOrderIds, refundCache, ...gate }: LocalReceiptsPanelProps) {
  const [search, setSearch] = useState('')
  if (!isOpen) return null
  const rows = filterLocalReceipts(receipts, search)
  return (
    <Sheet open variant="center" maxWidth="max-w-2xl" panelClassName="max-h-[90vh] flex flex-col" testId="local-receipts" title="Struk di tablet ini" header onClose={onClose}>
        <div className="px-5 py-3 border-b border-paper-2 flex-shrink-0">
          <label htmlFor="local-receipt-search" className="block text-xs text-ink-700 font-semibold mb-1">Cari nomor struk</label>
          <input id="local-receipt-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="mis. BSD-G0007"
            className="w-full min-h-11 surface-card rounded-control px-3 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong" />
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {rows.length === 0 && <p className="text-center text-sm text-ink-500 py-8">Belum ada struk di tablet ini</p>}
          {rows.map((r) => {
            const order = localReceiptOrder(r, paymentMethods)
            const cache = refundCache?.([r.orderUuid, ...(r.serverOrderId ? [r.serverOrderId] : [])])
            const badge = localBadge(r, partialGateFor(order, cache))
            return (
              <div key={r.orderUuid} className="surface-card rounded-control p-3" data-testid="local-receipt-row">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm text-ink-900">{r.orderNumber}</p>
                    <p className="text-xs text-ink-500">
                      {formatHistoryStamp(r.capturedAt)}
                      {' · '}{PAYMENT_LABELS[r.paymentMethod] ?? r.paymentMethod}
                    </p>
                    {visibleTenders(order).map((t) => (
                      <p key={t.seq} className="text-xs text-ink-500" data-testid="local-receipt-tender">{tenderLineText(t, paymentMethods)}</p>
                    ))}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-sm text-ink-900">{formatRupiah(r.quotedTotal ?? 0)}</p>
                    <StatusBadge tone={TONES[badge.tone]} label={badge.label} className="mt-1" />
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <Button variant="secondary" fullWidth onClick={() => onReprint(r)} disabled={!canReprint || reprintReceiptData(r) === null}>
                    Cetak Ulang
                  </Button>
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
