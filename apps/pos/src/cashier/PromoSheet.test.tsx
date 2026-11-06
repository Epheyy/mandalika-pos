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

  it('replaces the list with the picker instead of stacking it', () => {
    const out = html(createElement(PromoSheet, { onClose: noop, picker: createElement('p', null, 'PICKER'), children: createElement('p', null, 'LIST-BODY') }))
    expect(out).toContain('PICKER')
    expect(out).not.toContain('LIST-BODY')
    expect(out).not.toContain('Promo &amp; Diskon')
  })
})

describe('ManualDiscountSection', () => {
  const props = { state: CASHIER_INITIAL_STATE, dispatch: noop, onApplyDiscount: noop, onApplySurcharge: noop }

  it('starts collapsed: only the disclosure button, no input', () => {
    const out = html(createElement(ManualDiscountSection, props))
    expect(out).toContain('Diskon manual / Biaya tambahan')
    expect(out).toContain('aria-expanded="false"')
    expect(out).not.toContain('Nilai diskon atau biaya tambahan')
  })

  it('opens inline with the % / nominal toggle and both actions', () => {
    const out = html(createElement(ManualDiscountSection, { ...props, initiallyOpen: true }))
    expect(out).toContain('Persen (%)')
    expect(out).toContain('Nominal (Rp)')
    expect(out).toContain('Biaya tambahan +')
    expect(out).toContain('Nilai diskon atau biaya tambahan')
  })

  it('summarises an applied manual discount on the collapsed button', () => {
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

  it('keeps the legacy overlay when not inline', () => {
    expect(html(createElement(BxgyRewardModal, base))).toContain('fixed inset-0')
  })
})
