import { memo, useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { variantLabel } from '@mandalika/types'

type Order = components['schemas']['Order']

interface RefundDialogProps {
  order: Order | null
  isProcessing: boolean
  onConfirm: (orderId: string, reason: string) => void
  onClose: () => void
}

export const RefundDialog = memo(function RefundDialog({
  order,
  isProcessing,
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
    if (!reason.trim()) return
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

        <label className="block text-xs text-gray-700 font-semibold mb-1">
          Alasan Refund *
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Masukkan alasan refund…"
          rows={3}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 mb-4 resize-none"
        />

        <p className="text-[10px] text-gray-400 mb-4">
          Stok akan dipulihkan oleh server saat sinkronisasi.
        </p>

        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            disabled={isProcessing || !reason.trim()}
            className="flex-1 py-2.5 bg-red-600 text-white rounded-xl font-semibold text-sm disabled:opacity-40 hover:bg-red-700 transition-colors"
          >
            {isProcessing ? 'Memproses…' : 'Konfirmasi Refund'}
          </button>
          <button
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
