import { memo, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { ReceiptTotals } from './ReceiptTotals'
import type { TotalRow } from './receiptRows'
import { receiptRefLabel } from './orderRef'
import { brand } from '../brand'
import { variantLabel } from '@mandalika/types'
import { PAYMENT_LABELS } from '../lib/paymentLabels'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import type { OrderState } from './orderState'
import { IconCheck, IconWarning, IconPrinter } from '../components/ui/icons'

type AppSettings = components['schemas']['AppSettings']
type CartItem = components['schemas']['CartItem']

interface ReceiptPreviewProps {
  isOpen: boolean
  orderId: string | null
  /** Reserved order number (printed on the receipt); falls back to a hash of orderId. */
  orderNumber?: string | null
  items: CartItem[]
  /** The totals rows the printed receipt shows (receiptRows.quoteTotalRows). */
  totalRows: TotalRow[]
  paymentMethod: string
  amountPaid: number
  change: number
  customerName: string | null
  cashierName: string
  settings: AppSettings
  /** Sync state of THIS sale from the engine's local receipts; 'unknown' falls back to isPendingSync. */
  orderState: OrderState
  isPendingSync: boolean
  canReprint: boolean
  printError: string | null
  onReprint: () => void
  onClose: () => void
  onNewSale: () => void
  /** Opens Pengaturan Cetakan; when absent the no-printer line shows without a Pasangkan button. */
  onPairPrinter?: () => void
}


export const ReceiptPreview = memo(function ReceiptPreview({
  isOpen,
  orderId,
  orderNumber,
  items,
  totalRows,
  paymentMethod,
  amountPaid,
  change,
  customerName,
  cashierName,
  settings,
  orderState,
  isPendingSync,
  canReprint,
  printError,
  onReprint,
  onClose,
  onNewSale,
  onPairPrinter,
}: ReceiptPreviewProps) {
  const [printerLineDismissed, setPrinterLineDismissed] = useState(false)
  // A new success view starts with the no-printer line visible again.
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen)
    if (isOpen) setPrinterLineDismissed(false)
  }
  if (!isOpen) return null

  const now = new Date()
  const timeStr = now.toLocaleString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const refLabel = receiptRefLabel(orderNumber, orderId)
  // Per-order state from the engine's local receipts; 'unknown' keeps the old global-pending behaviour.
  const syncBadge =
    orderState === 'synced' ? (
      <StatusBadge tone="ok" size="md" label={`Terkirim · ${refLabel}`} />
    ) : orderState === 'parked' ? (
      <StatusBadge tone="danger" size="md" label="Perlu ditinjau · hubungi admin" />
    ) : orderState === 'queued' || isPendingSync ? (
      <StatusBadge tone="warn" size="md" label="Tersimpan di tablet · akan terkirim otomatis" />
    ) : (
      <p className="text-xs text-ink-500">{refLabel}</p>
    )

  return (
    <Sheet open variant="center" maxWidth="max-w-sm" panelClassName="max-h-[90vh] flex flex-col">
        {/* Success header */}
        <div className="flex flex-col items-center pt-6 pb-4 border-b border-paper-2 px-5">
          <div className="w-14 h-14 rounded-full bg-ok-bg flex items-center justify-center mb-3">
            <span className="text-ok"><IconCheck size={28} /></span>
          </div>
          <h3 className="font-bold text-ink-900 text-lg">Pembayaran Berhasil</h3>
          <div className="mt-2">{syncBadge}</div>
        </div>

        {/* Receipt body */}
        <div className="flex-1 overflow-y-auto p-5">
          <img
            src={brand.logo}
            alt={brand.displayName}
            className="h-9 w-auto object-contain mx-auto mb-3"
          />
          {settings.receipt.headerText && (
            <p className="text-xs text-center text-gray-500 mb-3">
              {settings.receipt.headerText}
            </p>
          )}

          <p className="text-[10px] text-gray-400 text-center mb-4">
            {timeStr}
          </p>

          {/* Items */}
          <div className="space-y-1 mb-4 border-t border-dashed border-gray-200 pt-3">
            {items.map((item) => (
              <div
                key={`${item.productId}-${item.variantSize}-${item.isReward ? item.rewardPromotionId ?? item.rewardConditionId ?? 'r' : ''}`}
                className="flex justify-between text-xs"
              >
                <span className="text-gray-700 flex-1 mr-2">
                  {item.productName}
                  <span className="text-gray-400 ml-1">
                    {variantLabel(item.variantSize) ? `${variantLabel(item.variantSize)} ×${item.quantity}` : `×${item.quantity}`}
                  </span>
                </span>
                <span className={`flex-shrink-0 font-medium ${item.isReward ? 'text-green-600' : 'text-gray-800'}`}>
                  {item.isReward && item.subtotal <= 0 ? 'GRATIS' : formatRupiah(item.subtotal)}
                </span>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="border-t border-dashed border-gray-200 pt-3 space-y-1 text-xs">
            <ReceiptTotals rows={totalRows} />
            <div className="flex justify-between text-gray-600">
              <span>{PAYMENT_LABELS[paymentMethod] ?? paymentMethod}</span>
              <span>{formatRupiah(amountPaid)}</span>
            </div>
            {change > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>Kembalian</span>
                <span>{formatRupiah(change)}</span>
              </div>
            )}
          </div>

          {/* Customer / cashier */}
          <div className="mt-3 border-t border-dashed border-gray-200 pt-3 text-[10px] text-gray-400 space-y-0.5">
            {customerName && <p>Pelanggan: {customerName}</p>}
            {settings.receipt.showCashier && <p>Kasir: {cashierName}</p>}
          </div>

          {settings.receipt.footerText && (
            <p className="text-[10px] text-center text-gray-400 mt-3">
              {settings.receipt.footerText}
            </p>
          )}
        </div>

        {/* Actions */}
        {printError && (
          <p className="px-5 text-xs text-danger mb-1 flex-shrink-0">
            <IconWarning size={12} className="inline-block align-[-0.125em]" /> {printError}
          </p>
        )}
        {!canReprint && !printerLineDismissed && (
          <div className="mx-5 mb-2 flex items-center gap-2 rounded-control bg-paper-1 px-3 py-2 flex-shrink-0">
            <p className="flex-1 text-xs text-ink-700">Struk tidak dicetak: printer belum dipasangkan</p>
            {onPairPrinter && (
              <Button variant="secondary" onClick={onPairPrinter}>
                Pasangkan
              </Button>
            )}
            <Button variant="ghost" onClick={() => setPrinterLineDismissed(true)}>
              Lewati
            </Button>
          </div>
        )}
        {canReprint && (
          <div className="px-5 pb-2 flex-shrink-0">
            <Button variant="secondary" fullWidth onClick={onReprint} leading={<IconPrinter size={14} />}>
              Cetak Ulang Struk
            </Button>
          </div>
        )}
        <div className="px-5 pb-5 space-y-2 flex-shrink-0">
          <Button size="lg" fullWidth onClick={onNewSale}>
            Transaksi Baru
          </Button>
          <Button variant="ghost" fullWidth onClick={onClose}>
            Tutup
          </Button>
        </div>
    </Sheet>
  )
})
