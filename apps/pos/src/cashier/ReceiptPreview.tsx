import { memo } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'

type AppSettings = components['schemas']['AppSettings']
type CartItem = components['schemas']['CartItem']

interface ReceiptPreviewProps {
  isOpen: boolean
  orderId: string | null
  items: CartItem[]
  total: number
  discountAmount: number
  taxAmount: number
  paymentMethod: string
  amountPaid: number
  change: number
  customerName: string | null
  cashierName: string
  settings: AppSettings
  isPendingSync: boolean
  canReprint: boolean
  printError: string | null
  onReprint: () => void
  onClose: () => void
  onNewSale: () => void
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tunai',
  card: 'Kartu',
  transfer: 'Transfer',
  qris: 'QRIS',
}

export const ReceiptPreview = memo(function ReceiptPreview({
  isOpen,
  orderId,
  items,
  total,
  discountAmount,
  taxAmount,
  paymentMethod,
  amountPaid,
  change,
  customerName,
  cashierName,
  settings,
  isPendingSync,
  canReprint,
  printError,
  onReprint,
  onClose,
  onNewSale,
}: ReceiptPreviewProps) {
  if (!isOpen) return null

  const subtotal = items.reduce((s, i) => s + i.subtotal, 0)
  const now = new Date()
  const timeStr = now.toLocaleString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl max-h-[90vh] flex flex-col">
        {/* Success header */}
        <div className="flex flex-col items-center pt-6 pb-4 border-b border-gray-100 px-5">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
            <span className="text-green-600 text-xl">✓</span>
          </div>
          <h3 className="font-bold text-gray-900 text-lg">Pembayaran Berhasil</h3>
          {isPendingSync ? (
            <p className="text-xs text-amber-600 mt-1">
              ⏳ Menunggu sinkronisasi ke server
            </p>
          ) : (
            <p className="text-xs text-gray-500 mt-1">
              {orderId ? `ID: ${orderId.slice(0, 8)}…` : 'Disinkronisasi'}
            </p>
          )}
        </div>

        {/* Receipt body */}
        <div className="flex-1 overflow-y-auto p-5">
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
                key={`${item.productId}-${item.variantSize}`}
                className="flex justify-between text-xs"
              >
                <span className="text-gray-700 flex-1 mr-2">
                  {item.productName}
                  <span className="text-gray-400 ml-1">
                    {item.variantSize} ×{item.quantity}
                  </span>
                </span>
                <span className="text-gray-800 font-medium flex-shrink-0">
                  {formatRupiah(item.subtotal)}
                </span>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="border-t border-dashed border-gray-200 pt-3 space-y-1 text-xs">
            <div className="flex justify-between text-gray-600">
              <span>Subtotal</span>
              <span>{formatRupiah(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Diskon</span>
                <span>−{formatRupiah(discountAmount)}</span>
              </div>
            )}
            {settings.taxEnabled && taxAmount > 0 && settings.receipt.showTax && (
              <div className="flex justify-between text-gray-600">
                <span>PPN</span>
                <span>{formatRupiah(taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-gray-900 text-sm pt-1 border-t border-gray-200">
              <span>Total</span>
              <span>{formatRupiah(total)}</span>
            </div>
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
          <p className="px-5 text-xs text-red-600 mb-1 flex-shrink-0">
            ⚠ {printError}
          </p>
        )}
        {canReprint && (
          <div className="px-5 pb-2 flex-shrink-0">
            <button
              onClick={onReprint}
              className="w-full py-2 border border-indigo-200 text-indigo-700 rounded-xl text-sm font-semibold hover:bg-indigo-50 transition-colors"
            >
              🖨 Cetak Ulang Struk
            </button>
          </div>
        )}
        <div className="px-5 pb-5 flex gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Tutup
          </button>
          <button
            onClick={onNewSale}
            className="flex-1 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-colors"
          >
            Transaksi Baru
          </button>
        </div>
      </div>
    </div>
  )
})
