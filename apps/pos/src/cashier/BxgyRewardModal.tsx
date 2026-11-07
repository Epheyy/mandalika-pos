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
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'

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
  /** B2: render as the content of the Promo & Diskon sheet (back arrow) instead of a z-60 overlay. */
  inline?: boolean
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
  inline = false,
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
            <h3 className="truncate font-bold text-ink-900"><IconGift size={16} className="inline-block align-[-0.125em]" /> Pilih Hadiah</h3>
            <p className="truncate text-xs text-ink-500">{promo.name}</p>
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

        <div className="border-b border-paper-2 bg-reward-bg px-5 py-2">
          <p className="text-xs font-semibold text-reward">
            {remaining > 0
              ? `Pilih ${remaining} hadiah lagi (dari ${due})`
              : `${due} hadiah dipilih`}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {options.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-500">
              Tidak ada produk hadiah tersedia
            </p>
          ) : (
            <div className="space-y-2">
              {options.map((o) => {
                const picked = countFor(o)
                const st = stockFor(stockProducts, o.productId, o.variantSize)
                const label = `${o.productName}${o.variantSize ? ` · ${o.variantSize}` : ''}`
                return (
                  // W7-13: a row card: name, stock + price line, and a − n + stepper (the + / − rules are the old tap rules).
                  <div
                    key={optionKey(o)}
                    className={`flex items-center gap-3 rounded-control px-3 py-2 ${
                      picked > 0 ? 'bg-reward-bg ring-2 ring-reward' : 'surface-card'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink-900">{label}</p>
                      <p className="tnum text-xs text-ink-700">
                        {st !== null && (
                          <span className={st > 0 ? 'text-ok' : 'font-bold text-danger'}>
                            {st > 0 ? `Stok tersedia: ${st} unit` : `Stok ${st}`}
                            {' · '}
                          </span>
                        )}
                        <span className="text-reward">{o.net <= 0 ? 'Gratis (Rp 0)' : formatRupiah(o.net)}</span>
                      </p>
                    </div>
                    {o.net <= 0 && <StatusBadge tone="reward" label="Gratis" className="flex-shrink-0" />}
                    <span className="flex flex-shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => removeLastPickFor(o)}
                        disabled={picked <= 0}
                        className="press inline-flex h-11 w-11 items-center justify-center rounded-control bg-paper-1 text-base font-bold leading-none text-ink-900 disabled:opacity-40"
                        aria-label={`Kurangi ${label}`}
                      >
                        −
                      </button>
                      <span className="tnum w-5 text-center text-sm font-bold text-ink-900">{picked}</span>
                      <button
                        type="button"
                        onClick={() => addPick(o)}
                        disabled={remaining <= 0 || countFor(o) >= availFor(o)}
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
          )}
        </div>

        <div className="flex flex-shrink-0 gap-2 border-t border-paper-2 px-5 py-4">
          <Button variant="secondary" onClick={onCancel} className="flex-1">
            Batal
          </Button>
          <Button onClick={() => onConfirm(picks)} disabled={!canConfirm} className="flex-1">
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
