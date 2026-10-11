import { memo, useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { MAX_REFUND_REASON_CHARS, variantLabel } from '@mandalika/types'
import { canSubmitRefundReason } from './refundView'

type Order = components['schemas']['Order']

interface RefundDialogProps {
  order: Order | null
  isProcessing: boolean
  /** Persistent error when the refund could not be stored on the device. */
  error?: string | null
  onConfirm: (orderId: string, reason: string) => void
  onClose: () => void
}

export const RefundDialog = memo(function RefundDialog({
  order,
  isProcessing,
  error,
  onConfirm,
  onClose,
}: RefundDialogProps) {
  const [reason, setReason] = useState('')

  // Clear the reason whenever a different order is opened (or the dialog
  // closes) so a previous refund's text never bleeds into the next one.
  useEffect(() => {
    setReason('')
  }, [order?.id])

  if (!order) return null

  const handleConfirm = () => {
    if (!canSubmitRefundReason(reason)) return
    onConfirm(order.id, reason.trim())
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
        <h3 className="font-bold text-gray-900 mb-1">Refund Order</h3>
        <p className="text-xs text-gray-500 mb-4">
          {order.orderNumber} · {formatRupiah(order.total)}
        </p>

        <div className="bg-gray-50 rounded-xl p-3 mb-4 space-y-1">
          {order.items.map((item) => (
            <div
              key={`${item.productId}-${item.variantSize}`}
              className="flex justify-between text-xs text-gray-700"
            >
              <span>
                {item.productName}{variantLabel(item.variantSize) ? ` ${variantLabel(item.variantSize)}` : ''} ×{item.quantity}
              </span>
              <span>{formatRupiah(item.subtotal)}</span>
            </div>
          ))}
        </div>

        <label htmlFor="refund-reason" className="block text-xs text-gray-700 font-semibold mb-1">
          Alasan Refund *
        </label>
        <textarea
          id="refund-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Masukkan alasan refund…"
          rows={3}
          maxLength={MAX_REFUND_REASON_CHARS}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 mb-1 resize-none"
        />
        <p className="text-[10px] text-gray-400 text-right mb-3">{`${[...reason].length}/${MAX_REFUND_REASON_CHARS}`}</p>

        <p className="text-[10px] text-gray-400 mb-4">
          Stok akan dipulihkan oleh server saat sinkronisasi.
        </p>

        {error && (
          <p role="alert" className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button"
            onClick={handleConfirm}
            disabled={isProcessing || !canSubmitRefundReason(reason)}
            className="flex-1 py-2.5 bg-red-600 text-white rounded-xl font-semibold text-sm disabled:opacity-40 hover:bg-red-700 transition-colors"
          >
            {isProcessing ? 'Memproses…' : 'Konfirmasi Refund'}
          </button>
          <button type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="flex-1 py-2.5 border border-gray-200 rounded-xl font-semibold text-sm text-gray-700 hover:bg-gray-50"
          >
            Batal
          </button>
        </div>
      </div>
    </div>
  )
})
