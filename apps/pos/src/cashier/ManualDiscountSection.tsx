import type { CashierState, CashierAction } from './state/cashierReducer'
import { formatRupiah } from './pricing'
import { Button } from '../components/ui/Button'

interface ManualDiscountSectionProps {
  state: CashierState
  dispatch: React.Dispatch<CashierAction>
  onApplyDiscount: () => void
  onApplySurcharge: () => void
  /** Cart subtotal, for the "maks" hint and the inline over-limit message (display only, never blocks Apply). */
  subtotal?: number
}

/** The "Diskon manual / Biaya tambahan" block at the bottom of the Promo & Diskon sheet (W7-12: always open,
 *  "bukan PROMO" tag, Nominal first, max hint, inline red message). Open to every cashier (D-11: no permission
 *  gate). Applying replaces the previous value. Values, dispatches and clamping are unchanged. */
export function ManualDiscountSection({ state, dispatch, onApplyDiscount, onApplySurcharge, subtotal }: ManualDiscountSectionProps) {
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

  const isPercent = state.discountType === 'percentage'
  const entered = parseFloat(state.adjustInputStr) || 0
  const hasCap = isPercent || subtotal !== undefined
  const maxHint = isPercent ? 'Maksimal 100%' : subtotal !== undefined ? `Maksimal sebesar subtotal ${formatRupiah(subtotal)}` : null
  const overLimit = isPercent ? entered > 100 : subtotal !== undefined && entered > subtotal
  const overMessage = isPercent
    ? 'Persentase tidak boleh lebih dari 100%.'
    : subtotal !== undefined
      ? `Potongan manual tidak boleh melebihi subtotal keranjang (${formatRupiah(subtotal)}).`
      : null

  return (
    <section className="surface-group rounded-panel p-4" data-testid="manual-discount">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm font-bold text-ink-900">Diskon manual / Biaya tambahan</span>
          {hasManual && <span className="block truncate text-[0.8125rem] text-promo">{summary}</span>}
        </span>
        <span className="flex-shrink-0 rounded-md bg-paper-1 px-2 py-0.5 text-xs font-bold text-ink-700">bukan PROMO</span>
      </div>

      <div className="mb-3 flex gap-2">
        {(['fixed', 'percentage'] as const).map((t) => (
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
      <label htmlFor="manual-discount-value" className="mb-1 block text-[0.8125rem] font-semibold text-ink-700">
        Nilai potongan{hasCap && maxHint ? ` (${maxHint.charAt(0).toLowerCase()}${maxHint.slice(1)})` : ''}
      </label>
      <input
        id="manual-discount-value"
        type="number"
        inputMode="numeric"
        value={state.adjustInputStr}
        onChange={(e) => dispatch({ type: 'SET_ADJUST_INPUT', value: e.target.value })}
        placeholder={isPercent ? 'Contoh: 10' : 'Contoh: 5000'}
        aria-label="Nilai diskon atau biaya tambahan"
        aria-invalid={overLimit || undefined}
        className={`min-h-12 w-full rounded-control bg-white px-3 text-sm focus:outline-none ${overLimit ? 'border-2 border-danger' : 'border border-paper-2 focus:ring-1 focus:ring-brand-strong'}`}
      />
      {overLimit && overMessage ? (
        <p role="alert" className="mt-1 text-xs font-semibold text-danger">{overMessage}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
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
    </section>
  )
}
