import { useState } from 'react'
import type { CashierState, CashierAction } from './state/cashierReducer'
import { formatRupiah } from './pricing'
import { Button } from '../components/ui/Button'

interface ManualDiscountSectionProps {
  state: CashierState
  dispatch: React.Dispatch<CashierAction>
  onApplyDiscount: () => void
  onApplySurcharge: () => void
  /** Opens expanded (the old standalone "Diskon manual" entry point). */
  initiallyOpen?: boolean
}

/** Collapsed "Diskon manual / Biaya tambahan" block at the bottom of the Promo & Diskon sheet.
 *  Open to every cashier (D-11: no permission gate). Applying replaces the previous value. */
export function ManualDiscountSection({ state, dispatch, onApplyDiscount, onApplySurcharge, initiallyOpen = false }: ManualDiscountSectionProps) {
  const [open, setOpen] = useState(initiallyOpen)
  const hasManual = state.discountRunning > 0 || state.surchargeRunning > 0
  const summary = [
    state.discountRunning > 0
      ? `Diskon manual ${state.appliedDiscountType === 'percentage' ? `${state.discountRunning}%` : formatRupiah(state.discountRunning)}`
      : null,
    state.surchargeRunning > 0
      ? `Biaya tambahan ${state.appliedSurchargeType === 'percentage' ? `${state.surchargeRunning}%` : formatRupiah(state.surchargeRunning)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="border-t border-paper-2 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="touch flex min-h-12 w-full items-center justify-between gap-2 rounded-control px-1 text-left active:bg-paper-1"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink-900">Diskon manual / Biaya tambahan</span>
          {hasManual && <span className="block truncate text-[0.8125rem] text-promo">{summary}</span>}
        </span>
        <span aria-hidden="true" className="text-ink-500">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="mt-2">
          <div className="mb-3 flex gap-2">
            {(['percentage', 'fixed'] as const).map((t) => (
              <Button
                key={t}
                variant="secondary"
                active={state.discountType === t}
                onClick={() => dispatch({ type: 'SET_DISCOUNT_TYPE', discountType: t })}
                className="flex-1"
              >
                {t === 'percentage' ? 'Persen (%)' : 'Nominal (Rp)'}
              </Button>
            ))}
          </div>
          <input
            type="number"
            inputMode="numeric"
            value={state.adjustInputStr}
            onChange={(e) => dispatch({ type: 'SET_ADJUST_INPUT', value: e.target.value })}
            placeholder={state.discountType === 'percentage' ? 'Contoh: 10' : 'Contoh: 5000'}
            aria-label="Nilai diskon atau biaya tambahan"
            className="mb-3 min-h-12 w-full rounded-control border border-paper-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-strong"
          />
          <div className="flex gap-2">
            <Button onClick={onApplyDiscount} className="flex-1">
              Diskon −
            </Button>
            <Button variant="secondary" onClick={onApplySurcharge} className="flex-1">
              Biaya tambahan +
            </Button>
          </div>
          {hasManual && (
            <Button variant="ghost" onClick={() => dispatch({ type: 'CLEAR_DISCOUNT' })} className="mt-2 w-full text-danger">
              Hapus diskon manual
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
