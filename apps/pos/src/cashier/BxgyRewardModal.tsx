/**
 * SP-Promo-3b reward fulfillment — separate-set buy_x_get_y reward picker.
 *
 * Mirrors the SP-CRM-9 "Hadiah Loyalti" picker (CheckoutPanel) + the SP-CRM-9b
 * drill-down presentation + the SP-CRM-9c `· Stok N` annotation, but keyed on a
 * promotion instead of a loyalty condition. The cashier picks `due` reward units
 * (each pick = one reward unit carrying rewardPromotionId); the same
 * variant may be picked multiple times. Confirm atomically applies aggregated
 * lines and the pending direct/code owner; Cancel applies nothing.
 *
 * DISPLAY ONLY — the server re-derives entitlement from paid lines, prices the
 * reward at net, and records the grant. The net price shown here mirrors
 * bxgyRewardOptions (pricing.ts).
 */

import { useState } from 'react'
import type { components } from '@mandalika/api'
import type { BXGYRewardOption } from './pricing'
import { formatRupiah } from './pricing'
import { stockFor } from './stock'
import { IconGift } from '../components/ui/icons'

type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']

export interface BxgyRewardPick {
  productId: string
  productName: string
  variantSize: string
  net: number
}

interface BxgyRewardModalProps {
  promo: Promotion
  options: BXGYRewardOption[]
  due: number
  stockProducts: Product[]
  onConfirm: (picks: BxgyRewardPick[]) => void
  onCancel: () => void
}

function optionKey(o: { productId: string; variantSize: string }): string {
  return `${o.productId}|${o.variantSize}`
}

export function BxgyRewardModal({
  promo,
  options,
  due,
  stockProducts,
  onConfirm,
  onCancel,
}: BxgyRewardModalProps) {
  // Each entry is one chosen reward unit (the same variant may appear more than
  // once). Length is capped at `due`.
  const [picks, setPicks] = useState<BxgyRewardPick[]>([])

  const remaining = due - picks.length
  const canConfirm = picks.length === due

  // A free reward is a giveaway — never let the cashier pick more units than are
  // in stock (independent of the allowNegativeStock setting, which governs SOLD
  // items, not gifts). Unknown stock (null) = unconstrained.
  const availFor = (o: { productId: string; variantSize: string }): number => {
    const st = stockFor(stockProducts, o.productId, o.variantSize)
    return st === null ? Infinity : Math.max(0, st)
  }

  const addPick = (o: BXGYRewardOption) => {
    if (picks.length >= due) return
    if (countFor(o) >= availFor(o)) return
    setPicks((prev) => [
      ...prev,
      {
        productId: o.productId,
        productName: o.productName,
        variantSize: o.variantSize,
        net: o.net,
      },
    ])
  }

  const removeLastPickFor = (o: { productId: string; variantSize: string }) => {
    const key = optionKey(o)
    setPicks((prev) => {
      const idx = [...prev].reverse().findIndex((p) => optionKey(p) === key)
      if (idx < 0) return prev
      const realIdx = prev.length - 1 - idx
      return [...prev.slice(0, realIdx), ...prev.slice(realIdx + 1)]
    })
  }

  const countFor = (o: { productId: string; variantSize: string }): number => {
    const key = optionKey(o)
    return picks.reduce((n, p) => (optionKey(p) === key ? n + 1 : n), 0)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Tutup"
        tabIndex={-1}
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
      />
      <div className="relative bg-white rounded-2xl w-full max-w-sm shadow-xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h3 className="font-bold text-gray-900 truncate"><IconGift size={16} className="inline-block align-[-0.125em]" /> Pilih Hadiah</h3>
            <p className="text-[11px] text-gray-500 truncate">{promo.name}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-2 border-b border-amber-100 bg-amber-50">
          <p className="text-[11px] font-semibold text-amber-800">
            {remaining > 0
              ? `Pilih ${remaining} hadiah lagi (dari ${due})`
              : `${due} hadiah dipilih`}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {options.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">
              Tidak ada produk hadiah tersedia
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => {
                const picked = countFor(o)
                const st = stockFor(stockProducts, o.productId, o.variantSize)
                return (
                  <div
                    key={optionKey(o)}
                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 ${
                      picked > 0
                        ? 'border-amber-500 bg-amber-50'
                        : 'border-amber-200 bg-white'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => addPick(o)}
                      disabled={remaining <= 0 || countFor(o) >= availFor(o)}
                      className="text-xs font-semibold text-amber-800 disabled:opacity-40 text-left"
                    >
                      {o.productName}
                      {o.variantSize ? ` · ${o.variantSize}` : ''}
                      <span className="ml-1 text-amber-600">
                        {o.net <= 0 ? 'GRATIS' : formatRupiah(o.net)}
                      </span>
                      {st !== null && (
                        <span className={st > 0 ? 'ml-1 text-amber-600' : 'ml-1 text-red-500 font-bold'}>
                          · Stok {st}
                        </span>
                      )}
                    </button>
                    {picked > 0 && (
                      <span className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => removeLastPickFor(o)}
                          className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 text-xs font-bold leading-none"
                          aria-label="Kurangi"
                        >
                          −
                        </button>
                        <span className="text-xs font-bold text-amber-800 w-4 text-center">{picked}</span>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-700 font-bold text-sm hover:bg-gray-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => onConfirm(picks)}
            disabled={!canConfirm}
            className="flex-1 py-2.5 rounded-xl bg-amber-600 text-white font-bold text-sm disabled:opacity-40 hover:bg-amber-700"
          >
            Terapkan
          </button>
        </div>
      </div>
    </div>
  )
}
