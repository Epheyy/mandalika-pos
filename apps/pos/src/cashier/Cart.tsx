import { memo } from 'react'
import type { components } from '@mandalika/api'
import type { CartDerived } from '../hooks/useCart'
import { formatRupiah } from './pricing'

type CartItem = components['schemas']['CartItem']
type AppSettings = components['schemas']['AppSettings']
type Customer = components['schemas']['Customer']

interface CartProps {
  cart: CartItem[]
  derived: CartDerived
  settings: AppSettings
  selectedCustomer: Customer | null
  pendingSync: boolean
  onRemove: (productId: string, variantSize: string) => void
  onSetQty: (productId: string, variantSize: string, qty: number) => void
  onClear: () => void
  onCheckout: () => void
  onOpenAdjustment: (panel: 'notes' | 'discount' | 'promo') => void
  discountRunning: number
  discountType: 'percentage' | 'fixed'
  surchargeRunning: number
  orderNotes: string
  appliedPromoLabel: string | null
  onClearDiscount: () => void
  onClearPromo: () => void
  loyaltyEnabled: boolean
  wallRaised: boolean
}

export const Cart = memo(function Cart({
  cart,
  derived,
  settings,
  selectedCustomer,
  pendingSync,
  onRemove,
  onSetQty,
  onClear,
  onCheckout,
  onOpenAdjustment,
  discountRunning,
  discountType,
  surchargeRunning,
  orderNotes,
  appliedPromoLabel,
  onClearDiscount,
  onClearPromo,
  loyaltyEnabled,
  wallRaised,
}: CartProps) {
  const isEmpty = cart.length === 0

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-100">
      {/* Active customer — pinned at the very top of the cart */}
      {selectedCustomer && (
        <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-100 flex-shrink-0">
          <p className="text-xs font-bold text-indigo-800 truncate">
            👤 {selectedCustomer.name}
          </p>
          <p className="text-[10px] text-indigo-600">
            {selectedCustomer.phone}
            {loyaltyEnabled && ` · ${selectedCustomer.points} poin`}
          </p>
        </div>
      )}
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
        <h2 className="font-bold text-gray-900 text-sm">
          Keranjang
          {derived.totalCartItems > 0 && (
            <span className="ml-1.5 bg-indigo-600 text-white text-xs rounded-full px-1.5 py-0.5">
              {derived.totalCartItems}
            </span>
          )}
        </h2>
        {!isEmpty && (
          <button
            onClick={onClear}
            className="text-xs text-red-500 hover:text-red-700 font-semibold"
          >
            Hapus semua
          </button>
        )}
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400">
            <p className="text-sm">Keranjang kosong</p>
            <p className="text-xs mt-1">Pilih produk untuk mulai</p>
          </div>
        ) : (
          cart.map((item) => (
            <div
              key={`${item.productId}-${item.variantSize}`}
              className="flex items-start gap-2 p-2 rounded-lg bg-gray-50"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-gray-800 truncate">
                  {item.productName}
                </p>
                <p className="text-xs text-gray-500">{item.variantSize}</p>
                <p className="text-xs text-indigo-600 font-bold">
                  {formatRupiah(item.subtotal)}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() =>
                    onSetQty(item.productId, item.variantSize, item.quantity - 1)
                  }
                  className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-gray-700 hover:bg-gray-300 text-xs"
                >
                  −
                </button>
                <span className="w-5 text-center text-xs font-bold">
                  {item.quantity}
                </span>
                <button
                  onClick={() =>
                    onSetQty(item.productId, item.variantSize, item.quantity + 1)
                  }
                  className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-gray-700 hover:bg-gray-300 text-xs"
                >
                  +
                </button>
                <button
                  onClick={() => onRemove(item.productId, item.variantSize)}
                  className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center text-red-500 hover:bg-red-200 text-xs ml-1"
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Adjustments row */}
      {!isEmpty && (
        <div className="px-3 py-2 border-t border-gray-100 flex gap-1 flex-shrink-0">
          <button
            onClick={() => onOpenAdjustment('notes')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              orderNotes
                ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Catatan
          </button>
          <button
            onClick={() => onOpenAdjustment('discount')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              discountRunning > 0 || surchargeRunning > 0
                ? 'border-orange-400 bg-orange-50 text-orange-700'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Diskon
          </button>
          <button
            onClick={() => onOpenAdjustment('promo')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              appliedPromoLabel
                ? 'border-green-400 bg-green-50 text-green-700'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Promo
          </button>
        </div>
      )}

      {/* Totals */}
      {!isEmpty && (
        <div className="px-4 py-3 border-t border-gray-100 space-y-1 flex-shrink-0 text-xs">
          <div className="flex justify-between text-gray-600">
            <span>Subtotal</span>
            <span>{formatRupiah(derived.subtotal)}</span>
          </div>
          {appliedPromoLabel && (
            <div className="flex justify-between items-center text-green-600">
              <span className="flex items-center gap-1">
                Promo: {appliedPromoLabel}
                <button
                  onClick={onClearPromo}
                  className="w-4 h-4 rounded-full bg-green-100 text-green-700 text-[10px] leading-none hover:bg-green-200"
                  title="Hapus promo"
                >
                  ×
                </button>
              </span>
            </div>
          )}
          {discountRunning > 0 && (
            <div className="flex justify-between items-center text-green-600">
              <span className="flex items-center gap-1">
                Diskon manual{' '}
                {discountType === 'percentage'
                  ? `${discountRunning}%`
                  : formatRupiah(discountRunning)}
                <button
                  onClick={onClearDiscount}
                  className="w-4 h-4 rounded-full bg-green-100 text-green-700 text-[10px] leading-none hover:bg-green-200"
                  title="Hapus diskon"
                >
                  ×
                </button>
              </span>
            </div>
          )}
          {derived.discountAmount > 0 && (
            <div className="flex justify-between text-green-600">
              <span>Total Diskon</span>
              <span>−{formatRupiah(derived.discountAmount)}</span>
            </div>
          )}
          {derived.surchargeAmount > 0 && (
            <div className="flex justify-between text-orange-600">
              <span>Surcharge</span>
              <span>+{formatRupiah(derived.surchargeAmount)}</span>
            </div>
          )}
          {settings.taxEnabled && derived.taxAmount > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>PPN {settings.taxRate}%</span>
              <span>{formatRupiah(derived.taxAmount)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-gray-900 text-sm pt-1 border-t border-gray-100">
            <span>Total</span>
            <span>{formatRupiah(derived.total)}</span>
          </div>
          {pendingSync && (
            <p className="text-[10px] text-amber-600 text-center mt-1">
              ⏳ Menunggu sinkronisasi
            </p>
          )}
        </div>
      )}

      {/* Checkout button */}
      <div className="px-3 pb-4 flex-shrink-0 safe-bottom">
        <button
          onClick={onCheckout}
          disabled={isEmpty || wallRaised}
          className="w-full py-3 bg-indigo-600 text-white rounded-xl font-bold text-sm disabled:opacity-40 hover:bg-indigo-700 transition-colors shadow-sm"
        >
          {wallRaised ? 'Sinkronisasi diperlukan' : 'Bayar'}
        </button>
      </div>
    </div>
  )
})
