import { memo, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { ReceiptTotals } from './ReceiptTotals'
import { receiptTenderRows, type TotalRow } from './receiptRows'
import { receiptRefLabel } from './orderRef'
import { collapseBundleLines, fromOrderItem } from './bundleReceipt'
import { brand } from '../brand'
import { variantLabel, resolveReceiptFlags } from '@mandalika/types'
import { PAYMENT_LABELS } from '../lib/paymentLabels'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import type { OrderState } from './orderState'
import type { GiveawayLine } from './giveaway'
import { IconCheck, IconWarning, IconPrinter } from '../components/ui/icons'

type AppSettings = components['schemas']['AppSettings']
type CartItem = components['schemas']['CartItem']

interface ReceiptPreviewProps {
  isOpen: boolean
  orderId: string | null
  /** Reserved order number (printed on the receipt); falls back to a hash of orderId. */
  orderNumber?: string | null
  items: CartItem[]
  /** C3: the giveaway row, the same line the paper prints when it was given. */
  giveaway?: GiveawayLine | null
  /** The totals rows the printed receipt shows (receiptRows.quoteTotalRows). */
  totalRows: TotalRow[]
  paymentMethod: string
  amountPaid: number
  /** C6: payment lines of a split sale (label already resolved); when present they replace the single payment row. */
  tenders?: { label: string; amount: number; reference?: string }[]
  change: number
  customerName: string | null
  /** Phone of the selected customer; shown only when the Backoffice flag is on, as the paper does. */
  customerPhone?: string | null
  cashierName: string
  settings: AppSettings
  /** When the sale was captured on this tablet (the engine's stored capture time). Never the render time (R11 F36). */
  capturedAt: Date | null
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
  giveaway,
  totalRows,
  paymentMethod,
  amountPaid,
  tenders,
  change,
  customerName,
  customerPhone,
  cashierName,
  settings,
  capturedAt,
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

  const flags = resolveReceiptFlags(settings.receipt)
  const timeStr = capturedAt
    ? capturedAt.toLocaleString('id-ID', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''

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

        {/* The cashier still needs the change when the paper hides it. */}
        {!flags.showChange && change > 0 && (
          <p className="px-5 pt-3 text-center text-sm font-bold text-ink-900" data-testid="change-callout">
            Kembalian {formatRupiah(change)}
          </p>
        )}

        {/* Receipt body */}
        <div className="flex-1 overflow-y-auto p-5">
          <img
            src={brand.logo}
            alt={brand.displayName}
            className="h-9 w-auto object-contain mx-auto mb-3"
          />
          {settings.receipt.headerText && (
            <p className="text-xs text-center text-ink-500 mb-3">
              {settings.receipt.headerText}
            </p>
          )}

          {flags.showOrderNumber && (
            <p className="text-xs text-ink-500 text-center" data-testid="receipt-order-number">No {refLabel}</p>
          )}
          <p className="text-xs text-ink-500 text-center mb-4" data-testid="receipt-time">
            {timeStr}
          </p>

          {/* Items */}
          <div className="space-y-1 mb-4 border-t border-dashed border-paper-2 pt-3">
            {collapseBundleLines(items.map((i) => ({ ...fromOrderItem(i), item: i })), () => undefined).map((entry) => {
              if (entry.kind === 'bundle') {
                return (
                  <div key={`bundle-${entry.group}`} data-testid="receipt-bundle" className="text-xs">
                    <div className="flex justify-between">
                      <span className="text-ink-700 flex-1 mr-2">{entry.name}</span>
                      <span className="flex-shrink-0 font-medium text-ink-900">{formatRupiah(entry.price)}</span>
                    </div>
                    {entry.pieces.map((p) => (
                      <p key={p} className="pl-2 text-ink-500">· {p}</p>
                    ))}
                    {entry.discount > 0 && (
                      <div className="flex justify-between text-promo">
                        <span className="pl-2">− {entry.discountLabel}</span>
                        <span>-{formatRupiah(entry.discount)}</span>
                      </div>
                    )}
                  </div>
                )
              }
              const item = entry.line.item
              return (
                <div
                  key={`${item.productId}-${item.variantSize}-${item.isReward ? item.rewardPromotionId ?? item.rewardConditionId ?? 'r' : ''}`}
                  className="flex justify-between text-xs"
                >
                  <span className="text-ink-700 flex-1 mr-2">
                    {item.productName}
                    <span className="text-ink-500 ml-1">
                      {variantLabel(item.variantSize) ? `${variantLabel(item.variantSize)} ×${item.quantity}` : `×${item.quantity}`}
                    </span>
                  </span>
                  <span className={`flex-shrink-0 font-medium ${item.isReward ? 'text-reward' : 'text-ink-900'}`}>
                    {item.isReward && item.subtotal <= 0 ? 'GRATIS' : formatRupiah(item.subtotal)}
                  </span>
                </div>
              )
            })}
            {giveaway && (
              <div className="flex justify-between text-xs" data-testid="receipt-giveaway">
                <span className="text-ink-700 flex-1 mr-2">
                  {giveaway.productName}
                  <span className="text-ink-500 ml-1">
                    {variantLabel(giveaway.variantSize) ? `${variantLabel(giveaway.variantSize)} ×1` : '×1'}
                  </span>
                </span>
                <span className="flex-shrink-0 font-medium text-reward">GRATIS</span>
              </div>
            )}
          </div>

          {/* Totals */}
          <div className="border-t border-dashed border-paper-2 pt-3 space-y-1 text-xs">
            <ReceiptTotals rows={totalRows} />
            {receiptTenderRows({ tenders, paymentLabel: PAYMENT_LABELS[paymentMethod] ?? paymentMethod, amountPaid }).map((t) => (
              <div key={t.key} className="text-ink-700" data-testid="receipt-tender">
                <div className="flex justify-between">
                  <span>{t.label}</span>
                  <span>{formatRupiah(t.amount)}</span>
                </div>
                {t.reference && <p className="text-xs text-ink-500">Ref {t.reference}</p>}
              </div>
            ))}
            {flags.showChange && change > 0 && (
              <div className="flex justify-between text-ink-700" data-testid="receipt-change">
                <span>Kembalian</span>
                <span>{formatRupiah(change)}</span>
              </div>
            )}
          </div>

          {/* Customer / cashier */}
          <div className="mt-3 border-t border-dashed border-paper-2 pt-3 text-xs text-ink-500 space-y-0.5">
            {flags.showCustomerName && customerName && <p>Pelanggan: {customerName}</p>}
            {flags.showCustomerPhone && customerPhone && <p>Telp: {customerPhone}</p>}
            {flags.showCashier && <p>Kasir: {cashierName}</p>}
          </div>

          {settings.receipt.footerText && (
            <p className="text-xs text-center text-ink-500 mt-3">
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
