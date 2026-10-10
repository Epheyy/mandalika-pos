import { memo, useState } from 'react'
import type { components } from '@mandalika/api'
import type { CartDerived } from '../hooks/useCart'
import { formatRupiah } from './pricing'
import { stockFor, overstockLines } from './stock'
import type { CartLineLike } from './stock'

type AppSettings = components['schemas']['AppSettings']
type Customer = components['schemas']['Customer']
type LoyaltyPreviewReward = components['schemas']['LoyaltyPreviewReward']
type Product = components['schemas']['Product']

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
  rewards: LoyaltyPreviewReward[]
  rewardsLoading: boolean
  stockProducts: Product[]
  pickedRewards: Record<string, { productId: string; variantSize: string }>
  onPickReward: (
    conditionId: string,
    product: { id: string; name: string },
    variant: { size: string; price: number },
  ) => void
  onClearReward: (conditionId: string) => void
  pointsToRedeem: number
  onPointsRedeemedChange: (points: number) => void
  onPaymentMethodChange: (method: PaymentMethod) => void
  onAmountPaidChange: (amount: string) => void
  onConfirm: () => void
  /** Persistent error shown when the sale could not be stored on the device. */
  saveError?: string | null
  onClose: () => void
  discountAmount: number
  taxAmount: number
  allowNegativeStock: boolean
  cartLines: CartLineLike[]
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
  rewards,
  rewardsLoading,
  stockProducts,
  pickedRewards,
  onPickReward,
  onClearReward,
  pointsToRedeem,
  onPointsRedeemedChange,
  onPaymentMethodChange,
  onAmountPaidChange,
  onConfirm,
  saveError,
  onClose,
  discountAmount,
  taxAmount,
  allowNegativeStock,
  cartLines,
}: CheckoutPanelProps) {
  // SP-CRM-9b: per-condition expand state; collapsed by default so a generous
  // menu doesn't flood the checkout. Picking auto-collapses.
  const [openRewards, setOpenRewards] = useState<Record<string, boolean>>({})
  // SP-CRM-9c: overstock confirm modal state
  const [showOverstockConfirm, setShowOverstockConfirm] = useState(false)

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

  // SP-CRM-9c: overstock guard — overstockLines returns [] when allowNegativeStock is true
  const overstock = overstockLines(cartLines, stockProducts, allowNegativeStock)
  const handleConfirmClick = () => {
    if (overstock.length > 0) {
      setShowOverstockConfirm(true)
      return
    }
    onConfirm()
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-2xl w-full max-w-md shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">Konfirmasi Pembayaran</h3>
          <button type="button"
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

          {/* Loyalty product rewards (online-only) */}
          {loyaltyEnabled && selectedCustomer && (rewardsLoading || rewards.length > 0) && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                🎁 Hadiah Loyalti
              </p>
              {rewardsLoading && (
                <p className="text-[11px] text-gray-400">Memeriksa hadiah…</p>
              )}
              <div className="space-y-3">
                {rewards.map((rw) => {
                  const picked = pickedRewards[rw.conditionId]
                  const pickedProduct = picked
                    ? rw.products.find((p) => p.id === picked.productId)
                    : undefined
                  const isExpanded = openRewards[rw.conditionId] ?? false
                  return (
                    <div key={rw.conditionId} className="border border-amber-200 bg-amber-50 rounded-xl p-3">
                      <button
                        type="button"
                        onClick={() => setOpenRewards((o) => ({ ...o, [rw.conditionId]: !isExpanded }))}
                        className="w-full flex items-center justify-between gap-2"
                      >
                        <span className="text-xs font-semibold text-amber-800 text-left">{rw.conditionName}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {!picked && (
                            <span className="text-[11px] font-bold text-green-600">Tersedia!</span>
                          )}
                          <span className="text-amber-700 text-xs">{isExpanded ? '▲' : '▼'}</span>
                        </span>
                      </button>
                      {picked && !isExpanded && (
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold text-green-600">
                            GRATIS: {pickedProduct?.name ?? ''}
                            {picked.variantSize ? ` · ${picked.variantSize}` : ''}
                          </p>
                          <span className="flex gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => setOpenRewards((o) => ({ ...o, [rw.conditionId]: true }))}
                              className="text-[11px] text-amber-700 underline"
                            >
                              Ganti
                            </button>
                            <button
                              type="button"
                              onClick={() => onClearReward(rw.conditionId)}
                              className="text-[11px] text-amber-700 underline"
                            >
                              Hapus
                            </button>
                          </span>
                        </div>
                      )}
                      {isExpanded && (
                        <>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {rw.products.flatMap((p) =>
                              p.variants.map((v) => {
                                const isSel = picked?.productId === p.id && picked?.variantSize === v.size
                                return (
                                  <button
                                    key={`${p.id}-${v.size}`}
                                    type="button"
                                    onClick={() => {
                                      onPickReward(rw.conditionId, { id: p.id, name: p.name }, v)
                                      setOpenRewards((o) => ({ ...o, [rw.conditionId]: false }))
                                    }}
                                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                                      isSel
                                        ? 'border-amber-500 bg-amber-600 text-white'
                                        : 'border-amber-200 bg-white text-amber-800 hover:bg-amber-100'
                                    }`}
                                  >
                                    {p.name}
                                    {v.size ? ` · ${v.size}` : ''}
                                    {(() => {
                                      const st = stockFor(stockProducts, p.id, v.size)
                                      return st === null ? null : (
                                        <span className={st > 0 ? 'ml-1 text-amber-600' : 'ml-1 text-red-500 font-bold'}>· Stok {st}</span>
                                      )
                                    })()}
                                  </button>
                                )
                              }),
                            )}
                          </div>
                          {picked && (
                            <button
                              type="button"
                              onClick={() => onClearReward(rw.conditionId)}
                              className="mt-1.5 text-[11px] text-amber-700 underline"
                            >
                              Batalkan hadiah
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
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
                  inputMode="numeric"
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
                  aria-label="Jumlah poin yang ditukar"
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
                <button type="button"
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
                inputMode="numeric"
                value={amountPaid}
                onChange={(e) => onAmountPaidChange(e.target.value)}
                placeholder={String(derived.total)}
                aria-label="Jumlah dibayar"
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 mb-2"
              />
              {/* Quick amount buttons */}
              <div className="flex gap-2 flex-wrap">
                {quickAmounts.map((amt) => (
                  <button type="button"
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
          {saveError && (
            <p role="alert" className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              {saveError}
            </p>
          )}
          <button type="button"
            onClick={handleConfirmClick}
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

      {/* SP-CRM-9c: overstock confirm modal — warn + override, z-[60] above CheckoutPanel z-50 */}
      {showOverstockConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Tutup"
            tabIndex={-1}
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowOverstockConfirm(false)}
          />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-sm w-full p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">⚠️</span>
              <h3 className="text-base font-black text-gray-900">Stok Tidak Mencukupi</h3>
            </div>
            <p className="text-xs text-gray-500 mb-3">Penjualan ini melebihi stok dan akan membuat stok minus:</p>
            <ul className="space-y-1 mb-4 max-h-40 overflow-y-auto">
              {overstock.map((line) => {
                const p = stockProducts.find((x) => x.id === line.productId)
                const avail = stockFor(stockProducts, line.productId, line.variantSize)
                return (
                  <li
                    key={`${line.productId}-${line.variantSize}`}
                    className="text-xs text-gray-700 flex justify-between gap-2"
                  >
                    <span className="font-semibold">
                      {p?.name ?? line.productId}
                      {line.variantSize ? ` · ${line.variantSize}` : ''}
                    </span>
                    <span className="text-red-600 font-bold shrink-0">
                      minta {line.quantity} · stok {avail ?? 0}
                    </span>
                  </li>
                )
              })}
            </ul>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowOverstockConfirm(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-700 font-bold text-sm hover:bg-gray-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => { setShowOverstockConfirm(false); onConfirm() }}
                className="flex-1 py-2.5 rounded-xl bg-amber-600 text-white font-bold text-sm hover:bg-amber-700"
              >
                Lanjutkan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
