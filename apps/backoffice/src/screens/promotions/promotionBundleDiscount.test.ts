import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Promotion, PromotionInput } from '@mandalika/api'
import { PromoTypeFields } from './PromoTypeFields'
import { EMPTY_PROMO, PROMO_FIELD, promotionProblems, promotionToInput, selectPromoType } from './promotionForm'

const promo = (over: Partial<PromotionInput>): PromotionInput => ({ ...EMPTY_PROMO, name: 'Promo', type: 'bundle_discount', combinable: true, ...over })
const messages = (f: PromotionInput) => promotionProblems(f).map((p) => p.message)

describe('Diskon Bundle form', () => {
  it('selecting Diskon Bundle seeds combinable on and percentage kind', () => {
    const f = selectPromoType({ ...EMPTY_PROMO, minPurchase: 50000, combinable: false }, 'bundle_discount')
    expect(f.type).toBe('bundle_discount')
    expect(f.combinable).toBe(true)
    expect(f.bundleDiscountConfig).toEqual({ kind: 'percentage', lines: [], sizes: [] })
    expect(f.minPurchase).toBeNull()
  })

  it('promotionProblems: "Diskon persen harus 1–99" at 100', () => {
    const cfg = { kind: 'percentage' as const, lines: [], sizes: [] }
    expect(messages(promo({ value: 100, bundleDiscountConfig: cfg }))).toContain('Diskon persen harus 1–99')
    expect(messages(promo({ value: 10.5, bundleDiscountConfig: cfg }))).toContain('Diskon persen harus 1–99')
    expect(messages(promo({ value: 99, bundleDiscountConfig: cfg }))).toEqual([])
  })

  it('promotionProblems mirrors the other server messages', () => {
    expect(messages(promo({ value: 10, bundleDiscountConfig: null }))).toContain('Pilih persen atau nominal')
    expect(messages(promo({ value: 0, bundleDiscountConfig: { kind: 'fixed', lines: [], sizes: [] } }))).toContain('Diskon nominal harus bilangan bulat > 0')
    expect(messages(promo({ value: 1000.5, bundleDiscountConfig: { kind: 'fixed', lines: [], sizes: [] } }))).toContain('Diskon nominal harus bilangan bulat > 0')
    const bad = promotionProblems(promo({ value: 10, bundleDiscountConfig: { kind: 'percentage', lines: [], sizes: ['120'] } }))
    expect(bad).toContainEqual(expect.objectContaining({ fieldId: PROMO_FIELD.bundleDiscount, message: 'Ukuran harus seperti 120ml' }))
  })

  it('promotionToInput sends bundleDiscountConfig with chosen lines and sizes', () => {
    const stored = {
      name: 'Akhir Tahun', type: 'bundle_discount', value: 10, isActive: true, codeOnly: false, createdAt: '2026-11-12T00:00:00Z', id: 'x',
      bundleDiscountConfig: { kind: 'percentage', lines: ['EXTRAIT DE PARFUM'], sizes: ['110ml'] },
    } as unknown as Promotion
    expect(promotionToInput(stored).bundleDiscountConfig).toEqual({ kind: 'percentage', lines: ['EXTRAIT DE PARFUM'], sizes: ['110ml'] })
  })

  it('line checkboxes list the ERP lines from bundle settings', () => {
    const form = promo({ value: 10, bundleDiscountConfig: { kind: 'percentage', lines: ['EXTRAIT DE PARFUM'], sizes: [] } })
    const html = renderToStaticMarkup(
      createElement(PromoTypeFields, {
        form, setForm: vi.fn(), products: [], errors: {},
        bundleLines: [{ line: 'EXTRAIT DE PARFUM', label: 'Extrait de Parfum' }, { line: 'PARFUM INTENSE', label: 'Parfum Intense' }],
        bundleSizes: ['100ml', '110ml', '120ml'],
      }),
    )
    expect(html).toContain('Extrait de Parfum')
    expect(html).toContain('Parfum Intense')
    expect(html).toContain('110ml')
    expect(html).toContain('Semua ukuran')
    expect(html).not.toContain('Semua lini')
  })
})
