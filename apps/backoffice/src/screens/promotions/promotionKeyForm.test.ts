import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PromotionInput } from '@mandalika/api'
import { PromoFormSlideOver } from './PromoFormSlideOver'
import { promotionProblems } from './promotionForm'

const OVERLAP_MESSAGE = 'tidak boleh dipakai di lebih dari satu slot'

// Render the real editor (SlideOver, sections, its Save button) without a browser. Nothing is stubbed: the validators
// run on the form, the screen passes the problems and whether Save is blocked, exactly as PromotionEditorHost does.
function render(form: PromotionInput): string {
  const problems = promotionProblems(form)
  return renderToStaticMarkup(
    createElement(PromoFormSlideOver, {
      editing: false, load: 'ready', loadError: null, form, setForm: vi.fn(), products: [], productsState: 'ready', outlets: [],
      dirty: false, busy: false, err: null, problems, saveBlocked: problems.length > 0, onSave: vi.fn(), onClose: vi.fn(),
    }),
  )
}

const saveButton = (html: string) => html.match(/<button\b[^>]*>(?:<[^>]+>)*Simpan(?:<\/[^>]+>)*<\/button>/)?.[0]

it.each(['bundle', 'buy_x_get_y'] as const)('%s Save is off for a semantic overlap, on for distinct variants, with the error shown inline', (type) => {
  for (const overlap of [true, false]) {
    const form: PromotionInput = {
      name: 'fixture', type, value: 0, isActive: true,
      bundleConfig: { slots: [{ productKeys: [overlap ? 'P' : 'P|L'], quantity: 1 }, { productKeys: ['P|M'], quantity: 1 }], bundlePrice: 50 },
      bxgyConfig: { buyProductIds: [overlap ? 'P' : 'P|L'], getProductIds: ['P|M'], buyQuantity: 1, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 },
    }
    const html = render(form)
    const save = saveButton(html)
    expect(save).toBeDefined()
    expect(save!.includes('disabled=""')).toBe(overlap)
    expect(html.includes('Produk atau varian')).toBe(overlap)
  }
})

it('a bundle that reuses a product in two slots also names that rule', () => {
  const form: PromotionInput = {
    name: 'fixture', type: 'bundle', value: 0, isActive: true,
    bundleConfig: { slots: [{ productKeys: ['P|M'], quantity: 1 }, { productKeys: ['P|M'], quantity: 1 }], bundlePrice: 50 },
  }
  expect(render(form)).toContain(OVERLAP_MESSAGE)
})

it('the editor is one scrolling panel with sections, not a wizard', () => {
  const html = render({ name: 'x', type: 'percentage', value: 10, isActive: true })
  for (const heading of ['Umum', 'Jenis dan nilai', 'Periode dan jadwal', 'Lokasi dan ketentuan']) expect(html).toContain(heading)
  expect(html).not.toContain('Lanjutkan')
  expect(html).toContain('Tambah Promosi')
  expect(html).toContain('Sepanjang hari')
  expect(html).toContain('Semua outlet')
})
