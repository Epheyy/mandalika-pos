import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PromoSheet } from './PromoSheet'
import { ManualDiscountSection } from './ManualDiscountSection'
import { BxgyRewardModal } from './BxgyRewardModal'
import { CASHIER_INITIAL_STATE } from './state/cashierReducer'

const noop = () => {}
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('PromoSheet', () => {
  it('shows the Promo & Diskon heading and the list when no picker is pending', () => {
    const out = html(createElement(PromoSheet, { onClose: noop, children: createElement('p', null, 'LIST-BODY') }))
    expect(out).toContain('Promo &amp; Diskon')
    expect(out).toContain('LIST-BODY')
  })

  it('shows exactly one Tutup control in the list view', () => {
    const out = html(createElement(PromoSheet, { onClose: noop, children: createElement('p', null, 'LIST-BODY') }))
    expect(out.match(/aria-label="Tutup"/g)).toHaveLength(2) // header close + the aria-hidden backdrop
    expect(out).toContain('aria-hidden="true" tabindex="-1"')
  })

  it('shows the subtotal beside the title (W7-11) and omits it when not given', () => {
    const withSub = html(createElement(PromoSheet, { onClose: noop, subtotal: 100000, children: createElement('p', null, 'x') }))
    expect(withSub).toMatch(/Subtotal Rp\s?100\.000/)
    expect(html(createElement(PromoSheet, { onClose: noop, children: createElement('p', null, 'x') }))).not.toContain('Subtotal')
  })

  it('replaces the list with the picker instead of stacking it', () => {
    const out = html(createElement(PromoSheet, { onClose: noop, picker: createElement('p', null, 'PICKER'), children: createElement('p', null, 'LIST-BODY') }))
    expect(out).toContain('PICKER')
    expect(out).not.toContain('LIST-BODY')
    expect(out).not.toContain('Promo &amp; Diskon')
  })
})

describe('ManualDiscountSection', () => {
  const props = { state: CASHIER_INITIAL_STATE, dispatch: noop, onApplyDiscount: noop, onApplySurcharge: noop }

  it('is an open block: bukan PROMO tag, Nominal before Persen, % / nominal toggle and both actions', () => {
    const out = html(createElement(ManualDiscountSection, props))
    expect(out).toContain('bukan PROMO')
    expect(out.indexOf('Nominal (Rp)')).toBeGreaterThan(-1)
    expect(out.indexOf('Nominal (Rp)')).toBeLessThan(out.indexOf('Persen (%)'))
    expect(out).toContain('Biaya tambahan +')
    expect(out).toContain('Nilai diskon atau biaya tambahan')
    expect(out).not.toContain('aria-expanded')
  })

  it('shows the max hint and an inline red message only when the nominal exceeds the subtotal', () => {
    const base = { ...props, subtotal: 100000 }
    const stateFixed = (adjustInputStr: string) => ({ ...CASHIER_INITIAL_STATE, discountType: 'fixed' as const, adjustInputStr })
    const ok = html(createElement(ManualDiscountSection, { ...base, state: stateFixed('50000') }))
    expect(ok).toContain('maksimal sebesar subtotal Rp')
    expect(ok).not.toContain('role="alert"')
    const over = html(createElement(ManualDiscountSection, { ...base, state: stateFixed('200000') }))
    expect(over).toContain('role="alert"')
    expect(over).toContain('tidak boleh melebihi subtotal')
  })

  it('flags a percentage above 100 inline', () => {
    const state = { ...CASHIER_INITIAL_STATE, discountType: 'percentage' as const, adjustInputStr: '150' }
    expect(html(createElement(ManualDiscountSection, { ...props, state }))).toContain('tidak boleh lebih dari 100%')
  })

  it('summarises an applied manual discount in the always-open block', () => {
    const state = { ...CASHIER_INITIAL_STATE, discountRunning: 10, appliedDiscountType: 'percentage' as const }
    expect(html(createElement(ManualDiscountSection, { ...props, state }))).toContain('Diskon manual 10%')
  })
})

describe('BxgyRewardModal inline', () => {
  const promo = { id: 'x', name: 'Beli 2 Gratis 1' } as never
  const base = { promo, options: [], due: 1, stockProducts: [], onConfirm: noop, onCancel: noop }

  it('renders a Kembali header and no fixed overlay inside the sheet', () => {
    const out = html(createElement(BxgyRewardModal, { ...base, inline: true }))
    expect(out).toContain('‹ Kembali')
    expect(out).not.toContain('fixed inset-0')
  })

  it('puts Kembali before the title (top-left) and renders row cards with a - n + stepper', () => {
    const options = [{ productId: 'p', productName: 'Amber Oud', variantSize: '10ml', net: 0 }] as never
    const out = html(createElement(BxgyRewardModal, { ...base, options, inline: true }))
    expect(out.indexOf('‹ Kembali')).toBeLessThan(out.indexOf('Pilih Hadiah'))
    expect(out).toContain('Gratis (Rp 0)')
    expect(out).toContain('aria-label="Tambah Amber Oud · 10ml"')
    expect(out).toContain('aria-label="Kurangi Amber Oud · 10ml"')
  })

  it('keeps the legacy overlay when not inline', () => {
    expect(html(createElement(BxgyRewardModal, base))).toContain('fixed inset-0')
  })
})
