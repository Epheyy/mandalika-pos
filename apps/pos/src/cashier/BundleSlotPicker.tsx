/**
 * SP-Promo-3b-bundle — slot picker for AMBIGUOUS bundle slots.
 *
 * A `bundle` prices a set of products at bundlePrice. When a slot has MORE
 * eligible cart units than it needs, the cashier chooses WHICH units fill it
 * (free choice — including a pricier unit; the customer then pays for the
 * cheaper one as a normal standalone item). The picked units become the slot's
 * consumed set fed to computeBundleFreed; the server guard accepts any eligible
 * choice (financially safe). Slots with exactly the needed number of units
 * auto-fill and are shown read-only.
 *
 * Mirrors BxgyRewardModal's structure/styles + the `· Stok N` annotation.
 * DISPLAY ONLY — the server re-derives the freed set from the paid lines.
 */

import { useState } from 'react'
import type { components } from '@mandalika/api'
import type { BundleAssignment, BundleUnitRef } from './bundle'
import { bundleApplications, keyMatchesLine } from './pricing'
import { formatRupiah } from './pricing'
import { IconPackage } from '../components/ui/icons'

type CartItem = components['schemas']['CartItem']
type BundleConfig = NonNullable<components['schemas']['Promotion']['bundleConfig']>

interface EligibleLine {
  productId: string
  variantSize: string
  productName: string
  price: number
  available: number // paid units of this (productId, variantSize) in the cart
}

interface SlotView {
  index: number
  need: number
  eligible: EligibleLine[]
  totalUnits: number
  ambiguous: boolean
}

interface BundleSlotPickerProps {
  cfg: BundleConfig
  cart: CartItem[]
  promoName: string
  stockFor: (productId: string, variantSize: string) => number | null
  onConfirm: (assignment: BundleAssignment) => void
  onCancel: () => void
}

function lineKey(l: { productId: string; variantSize: string }): string {
  return `${l.productId}|${l.variantSize}`
}

// Per-slot eligible paid lines (distinct SKUs) + the unit count needed.
function buildSlotViews(cfg: BundleConfig, cart: CartItem[]): SlotView[] {
  const paid = cart.filter((c) => !c.isReward)
  const nApp = bundleApplications(cfg, paid)
  return cfg.slots.map((slot, index) => {
    const need = nApp * slot.quantity
    const eligible: EligibleLine[] = []
    let totalUnits = 0
    for (const it of paid) {
      if (!keyMatchesLine(slot.productKeys, it.productId, it.variantSize)) continue
      totalUnits += it.quantity
      eligible.push({
        productId: it.productId,
        variantSize: it.variantSize,
        productName: it.productName,
        price: it.price,
        available: it.quantity,
      })
    }
    return { index, need, eligible, totalUnits, ambiguous: totalUnits > need }
  })
}

export function BundleSlotPicker({
  cfg,
  cart,
  promoName,
  stockFor,
  onConfirm,
  onCancel,
}: BundleSlotPickerProps) {
  const slots = buildSlotViews(cfg, cart)
  const ambiguousSlots = slots.filter((s) => s.ambiguous)

  // selections[slotIndex][lineKey] = number of units chosen from that line.
  const [selections, setSelections] = useState<Record<number, Record<string, number>>>({})

  const selectedCount = (slotIndex: number): number =>
    Object.values(selections[slotIndex] ?? {}).reduce((n, v) => n + v, 0)

  const countFor = (slotIndex: number, l: EligibleLine): number =>
    selections[slotIndex]?.[lineKey(l)] ?? 0

  const addUnit = (slot: SlotView, l: EligibleLine) => {
    if (selectedCount(slot.index) >= slot.need) return
    if (countFor(slot.index, l) >= l.available) return
    setSelections((prev) => {
      const slotSel = { ...(prev[slot.index] ?? {}) }
      slotSel[lineKey(l)] = (slotSel[lineKey(l)] ?? 0) + 1
      return { ...prev, [slot.index]: slotSel }
    })
  }

  const removeUnit = (slot: SlotView, l: EligibleLine) => {
    setSelections((prev) => {
      const current = prev[slot.index]?.[lineKey(l)] ?? 0
      if (current <= 0) return prev
      const slotSel = { ...(prev[slot.index] ?? {}) }
      if (current - 1 <= 0) delete slotSel[lineKey(l)]
      else slotSel[lineKey(l)] = current - 1
      return { ...prev, [slot.index]: slotSel }
    })
  }

  const canConfirm = ambiguousSlots.every((s) => selectedCount(s.index) === s.need)

  const handleConfirm = () => {
    const assignment: BundleAssignment = {}
    for (const slot of ambiguousSlots) {
      const refs: BundleUnitRef[] = []
      for (const l of slot.eligible) {
        const n = countFor(slot.index, l)
        for (let i = 0; i < n; i++) refs.push({ productId: l.productId, variantSize: l.variantSize })
      }
      assignment[slot.index] = refs
    }
    onConfirm(assignment)
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
            <h3 className="font-bold text-gray-900 truncate"><IconPackage size={16} className="inline-block align-[-0.125em]" /> Pilih Item Paket</h3>
            <p className="text-[11px] text-gray-500 truncate">{promoName}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-2 border-b border-indigo-100 bg-indigo-50">
          <p className="text-[11px] font-semibold text-indigo-800">
            Beberapa item memenuhi syarat — pilih mana yang masuk paket.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {slots.map((slot) => {
            const remaining = slot.need - selectedCount(slot.index)
            return (
              <div key={slot.index}>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[11px] font-bold text-gray-500 tracking-wide uppercase">
                    Slot {slot.index + 1} · butuh {slot.need}
                  </p>
                  {slot.ambiguous ? (
                    <span className="text-[10px] font-semibold text-indigo-600">
                      {remaining > 0 ? `pilih ${remaining} lagi` : 'lengkap'}
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold text-gray-400">otomatis</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {slot.eligible.map((l) => {
                    const st = stockFor(l.productId, l.variantSize)
                    const picked = countFor(slot.index, l)
                    if (!slot.ambiguous) {
                      // Auto-filled slot: read-only display of the consumed line(s).
                      return (
                        <div
                          key={lineKey(l)}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5"
                        >
                          <span className="text-xs font-semibold text-gray-700">
                            {l.available}× {l.productName}
                            {l.variantSize ? ` · ${l.variantSize}` : ''}
                            <span className="ml-1 text-gray-500">{formatRupiah(l.price)}</span>
                          </span>
                        </div>
                      )
                    }
                    return (
                      <div
                        key={lineKey(l)}
                        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 ${
                          picked > 0 ? 'border-indigo-500 bg-indigo-50' : 'border-indigo-200 bg-white'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => addUnit(slot, l)}
                          disabled={remaining <= 0 || picked >= l.available}
                          className="text-xs font-semibold text-indigo-800 disabled:opacity-40 text-left"
                        >
                          {l.productName}
                          {l.variantSize ? ` · ${l.variantSize}` : ''}
                          <span className="ml-1 text-indigo-600">{formatRupiah(l.price)}</span>
                          {st !== null && (
                            <span className={st > 0 ? 'ml-1 text-indigo-500' : 'ml-1 text-red-500 font-bold'}>
                              · Stok {st}
                            </span>
                          )}
                        </button>
                        {picked > 0 && (
                          <span className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => removeUnit(slot, l)}
                              className="w-5 h-5 rounded-full bg-indigo-200 text-indigo-800 text-xs font-bold leading-none"
                              aria-label="Kurangi"
                            >
                              −
                            </button>
                            <span className="text-xs font-bold text-indigo-800 w-4 text-center">{picked}</span>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
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
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white font-bold text-sm disabled:opacity-40 hover:bg-indigo-700"
          >
            Terapkan
          </button>
        </div>
      </div>
    </div>
  )
}
