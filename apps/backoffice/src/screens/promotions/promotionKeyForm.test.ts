import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PromoFormModal } from './PromoFormModal'
import type { PromotionInput } from '@mandalika/api'

// Render the real wizard at its final step without a browser. Only the initial
// wizard index is changed; its validators and real Save button are not stubbed.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => actual.useState(initial === 0 ? 2 : initial) }
})
it.each(['bundle', 'buy_x_get_y'] as const)('%s real Save gate rejects semantic overlap, permits distinct variants', type => {
  for (const overlap of [true, false]) {
    const form: PromotionInput = { name: 'fixture', type, value: 0, isActive: true,
      bundleConfig: { slots: [{ productKeys: [overlap ? 'P' : 'P|L'], quantity: 1 }, { productKeys: ['P|M'], quantity: 1 }], bundlePrice: 50 },
      bxgyConfig: { buyProductIds: [overlap ? 'P' : 'P|L'], getProductIds: ['P|M'], buyQuantity: 1, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 } }
    const html = renderToStaticMarkup(createElement(PromoFormModal, { form, open: true, editingPromo: false, setForm: () => {}, products: [], outlets: [], variantPicker: null, setVariantPicker: () => {}, busy: false, onSave: vi.fn(), onClose: () => {} }))
    const save = html.match(/<button\b[^>]*>Simpan<\/button>/)?.[0]
    expect(save).toBeDefined()
    expect(save!.includes('disabled=""')).toBe(overlap)
  }
})
