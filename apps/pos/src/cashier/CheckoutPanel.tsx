import { memo } from 'react'
import type { components } from '@mandalika/api'
import type { CartDerived } from '../hooks/useCart'
import { formatRupiah } from './pricing'

type AppSettings = components['schemas']['AppSettings']
type Customer = components['schemas']['Customer']

type PaymentMethod = 'cash' | 'card' | 'transfer' | 'qris'

interface CheckoutPanelProps {
  isOpen: boolean
  isProcessing: boolean
  derived: CartDerived
  settings: AppSettings
  paymentMethod: PaymentMethod
  amountPaid: string
  selectedCustomer: Customer | null
  orderNotes: string
  salesmen: { id: string; name: string }[]
  selectedSalesmanId: string | null
  onSelectSalesman: (salesman: { id: string; name: string } | null) => void
  loyaltyEnabled: boolean
  customerPoints: number
  pointsToRedeem: number
  onPointsRedeemedChange: (points: number) => void
  onPaymentMethodChange: (method: PaymentMethod) => void
  onAmountPaidChange: (amount: string) => void
  onConfirm: () => void
  onClose: () => void
  discountAmount: number
  taxAmount: number
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Tunai',
  card: 'Kartu',
  transfer: 'Transfer',
  qris: 'QRIS',
}

export const CheckoutPanel = memo(function CheckoutPanel({
  isOpen,
  isProcessing,
  derived,
  settings,
  paymentMethod,
  amountPaid,
  selectedCustomer,
  orderNotes,
  salesmen,
  selectedSalesmanId,
  onSelectSalesman,
  loyaltyEnabled,
  customerPoints,
  pointsToRedeem,
  onPointsRedeemedChange,
  onPaymentMethodChange,
  onAmountPaidChange,
  onConfirm,
  onClose,
  discountAmount,
  taxAmount,
}: CheckoutPanelProps) {
  if (!isOpen) return null

  const enabledMethods = settings.paymentMethods.filter((m) => m.isEnabled)
  const paidNum = parseFloat(amountPaid.replace(/\./g, '')) || 0
  const changeAmt = Math.max(0, paidNum - derived.total)
  const isCashShort =
    paymentMethod === 'cash' && paidNum < derived.total

  const quickAmounts = [
    derived.total,
    Math.ceil(derived.total / 10000) * 10000,
    Math.ceil(derived.total / 50000) * 50000,
    Math.ceil(derived.total / 100000) * 100000,
  ].filter((v, i, a) => a.indexOf(v) === i && v >= derived.total)

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
      <div
        className="bg-white rounded-2xl w-full max-w-md shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">Konfirmasi Pembayaran</h3>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Totals summary */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>Subtotal</span>
              <span>{formatRupiah(derived.subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Diskon</span>
                <span>−{formatRupiah(discountAmount)}</span>
              </div>
            )}
            {derived.surchargeAmount > 0 && (
              <div className="flex justify-between text-orange-600">
                <span>Surcharge</span>
                <span>+{formatRupiah(derived.surchargeAmount)}</span>
              </div>
            )}
            {settings.taxEnabled && taxAmount > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>PPN {settings.taxRate}%</span>
                <span>{formatRupiah(taxAmount)}</span>
              </div>
            )}
            {derived.redeemAmount > 0 && (
              <div className="flex justify-between text-indigo-600">
                <span>Tukar Poin ({derived.redeemedPoints})</span>
                <span>−{formatRupiah(derived.redeemAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-gray-900 text-base pt-2 border-t border-gray-200">
              <span>Total</span>
              <span>{formatRupiah(derived.total)}</span>
            </div>
          </div>

          {/* Customer info */}
          {selectedCustomer && (
            <div className="flex items-center gap-2 p-3 bg-indigo-50 rounded-xl text-xs">
              <span className="text-indigo-600">👤</span>
              <div>
                <p className="font-semibold text-indigo-800">
                  {selectedCustomer.name}
                </p>
                <p className="text-indigo-600">{selectedCustomer.phone}</p>
              </div>
            </div>
          )}

          {/* Notes */}
          {orderNotes && (
            <div className="p-3 bg-yellow-50 rounded-xl text-xs text-yellow-800">
              <span className="font-semibold">Catatan: </span>
              {orderNotes}
            </div>
          )}

          {/* Loyalty redemption */}
          {loyaltyEnabled && selectedCustomer && customerPoints > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                Tukar Poin Loyalti
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={customerPoints}
                  value={pointsToRedeem || ''}
                  onChange={(e) =>
                    onPointsRedeemedChange(
                      Math.min(
                        customerPoints,
                        Math.max(0, parseInt(e.target.value) || 0),
                      ),
                    )
                  }
                  placeholder="0"
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                <button
                  type="button"
                  onClick={() => onPointsRedeemedChange(customerPoints)}
                  className="px-3 py-2.5 bg-indigo-50 text-indigo-700 rounded-xl text-xs font-semibold hover:bg-indigo-100 transition-colors"
                >
                  Semua
                </button>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                Tersedia {customerPoints} poin
                {pointsToRedeem > 0 && derived.redeemAmount > 0
                  ? ` · potongan ${formatRupiah(derived.redeemAmount)}`
                  : ''}
              </p>
            </div>
          )}

          {/* Salesman */}
          {salesmen.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                Sales (opsional)
              </p>
              <select
                value={selectedSalesmanId ?? ''}
                onChange={(e) => {
                  const s = salesmen.find((x) => x.id === e.target.value)
                  onSelectSalesman(s ? { id: s.id, name: s.name } : null)
                }}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
              >
                <option value="">— Tanpa sales —</option>
                {salesmen.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Payment method */}
          <div>
            <p className="text-xs font-semibold text-gray-700 mb-2">
              Metode Pembayaran
            </p>
            <div className="grid grid-cols-2 gap-2">
              {enabledMethods.map((m) => (
                <button
                  key={m.id}
                  onClick={() =>
                    onPaymentMethodChange(m.id as PaymentMethod)
                  }
                  className={`py-2.5 rounded-xl text-sm font-semibold border transition-all ${
                    paymentMethod === m.id
                      ? 'border-indigo-500 bg-indigo-600 text-white'
                      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {PAYMENT_LABELS[m.id as PaymentMethod] ?? m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Amount paid (cash only) */}
          {paymentMethod === 'cash' && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                Jumlah Dibayar
              </p>
              <input
                type="number"
                value={amountPaid}
                onChange={(e) => onAmountPaidChange(e.target.value)}
                placeholder={String(derived.total)}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 mb-2"
              />
              {/* Quick amount buttons */}
              <div className="flex gap-2 flex-wrap">
                {quickAmounts.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => onAmountPaidChange(String(amt))}
                    className="px-3 py-1.5 bg-gray-100 hover:bg-indigo-50 text-gray-700 rounded-lg text-xs font-semibold transition-colors"
                  >
                    {formatRupiah(amt)}
                  </button>
                ))}
              </div>
              {paidNum > 0 && paidNum >= derived.total && (
                <div className="flex justify-between text-sm font-bold text-green-600 mt-2">
                  <span>Kembalian</span>
                  <span>{formatRupiah(changeAmt)}</span>
                </div>
              )}
              {isCashShort && (
                <p className="text-xs text-red-500 mt-1">
                  Kurang {formatRupiah(derived.total - paidNum)}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Confirm button */}
        <div className="px-5 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onConfirm}
            disabled={isProcessing || isCashShort}
            className="w-full py-3.5 bg-green-600 text-white rounded-xl font-bold text-sm disabled:opacity-40 hover:bg-green-700 transition-colors shadow-sm"
          >
            {isProcessing ? 'Memproses…' : `Konfirmasi ${formatRupiah(derived.total)}`}
          </button>
          <p className="text-[10px] text-gray-400 text-center mt-2">
            Order akan disinkronisasi ke server secara otomatis
          </p>
        </div>
      </div>
    </div>
  )
})
