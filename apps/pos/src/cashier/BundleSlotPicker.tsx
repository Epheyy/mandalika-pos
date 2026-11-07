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
import { Button } from '../components/ui/Button'

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
  /** B2: render as the content of the Promo & Diskon sheet (back arrow) instead of a z-60 overlay. */
  inline?: boolean
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
  inline = false,
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

  const panel = (
      <div className={inline ? 'flex h-full min-h-0 flex-col' : 'surface-solid relative flex max-h-[80vh] w-full max-w-sm flex-col rounded-panel'}>
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-paper-2 px-5 py-3">
          {inline && (
            // W5-02: "‹ Kembali" top-left, like the mock and every other sheet.
            <button
              type="button"
              onClick={onCancel}
              className="press -ml-2 inline-flex min-h-11 flex-shrink-0 items-center rounded-control px-3 text-sm font-semibold text-brand-strong active:bg-paper-1"
            >
              ‹ Kembali
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-bold text-ink-900"><IconPackage size={16} className="inline-block align-[-0.125em]" /> Pilih Item Paket</h3>
            <p className="truncate text-xs text-ink-500">{promoName}</p>
          </div>
          {!inline && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Tutup"
              className="press -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-control text-xl leading-none text-ink-500 active:bg-paper-1"
            >
              ×
            </button>
          )}
        </div>

        <div className="border-b border-paper-2 bg-promo-bg px-5 py-2">
          <p className="text-xs font-semibold text-promo">
            Beberapa item memenuhi syarat — pilih mana yang masuk paket.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {slots.map((slot) => {
            const remaining = slot.need - selectedCount(slot.index)
            return (
              <div key={slot.index}>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs font-bold uppercase tracking-wide text-ink-500">
                    Slot {slot.index + 1} · butuh {slot.need}
                  </p>
                  {slot.ambiguous ? (
                    <span className="text-xs font-semibold text-promo">
                      {remaining > 0 ? `pilih ${remaining} lagi` : 'lengkap'}
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-ink-500">otomatis</span>
                  )}
                </div>
                <div className="space-y-2">
                  {slot.eligible.map((l) => {
                    const st = stockFor(l.productId, l.variantSize)
                    const picked = countFor(slot.index, l)
                    const label = `${l.productName}${l.variantSize ? ` · ${l.variantSize}` : ''}`
                    if (!slot.ambiguous) {
                      // Auto-filled slot: read-only display of the consumed line(s).
                      return (
                        <div
                          key={lineKey(l)}
                          className="flex min-h-11 items-center gap-3 rounded-control bg-paper-1 px-3 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-700">
                            {l.available}× {label}
                          </span>
                          <span className="tnum flex-shrink-0 text-sm text-ink-700">{formatRupiah(l.price)}</span>
                        </div>
                      )
                    }
                    // W7-13: the same row card as the BXGY picker: name, stock + price line, − n + stepper.
                    return (
                      <div
                        key={lineKey(l)}
                        className={`flex items-center gap-3 rounded-control px-3 py-2 ${
                          picked > 0 ? 'bg-promo-bg ring-2 ring-promo' : 'surface-card'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-ink-900">{label}</p>
                          <p className="tnum text-xs text-ink-700">
                            {st !== null && (
                              <span className={st > 0 ? 'text-ok' : 'font-bold text-danger'}>
                                {st > 0 ? `Stok tersedia: ${st} unit` : 'Stok 0'}
                                {' · '}
                              </span>
                            )}
                            <span className="text-promo">{formatRupiah(l.price)}</span>
                          </p>
                        </div>
                        <span className="flex flex-shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => removeUnit(slot, l)}
                            disabled={picked <= 0}
                            className="press inline-flex h-11 w-11 items-center justify-center rounded-control bg-paper-1 text-base font-bold leading-none text-ink-900 disabled:opacity-40"
                            aria-label={`Kurangi ${label}`}
                          >
                            −
                          </button>
                          <span className="tnum w-5 text-center text-sm font-bold text-ink-900">{picked}</span>
                          <button
                            type="button"
                            onClick={() => addUnit(slot, l)}
                            disabled={remaining <= 0 || picked >= l.available}
                            className="press inline-flex h-11 w-11 items-center justify-center rounded-control bg-paper-1 text-base font-bold leading-none text-ink-900 disabled:opacity-40"
                            aria-label={`Tambah ${label}`}
                          >
                            +
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex flex-shrink-0 gap-2 border-t border-paper-2 px-5 py-4">
          <Button variant="secondary" onClick={onCancel} className="flex-1">
            Batal
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} className="flex-1">
            Terapkan
          </Button>
        </div>
      </div>
  )
  if (inline) return panel
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Tutup"
        tabIndex={-1}
        className="absolute inset-0 bg-ink-900/40"
        onClick={onCancel}
      />
      {panel}
    </div>
  )
}
