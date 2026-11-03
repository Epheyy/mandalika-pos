import { describe, expect, it } from 'vitest'
import type { PromotionInput } from '@mandalika/api'
import { codeProblems } from './discountCodeForm'
import {
  DEFAULT_PAGE_SIZE,
  PROMO_LIST_SCHEMA,
  activePromoFilterCount,
  clampPage,
  describePromoFilters,
  isPastLastPage,
  normalizePromoList,
  toPromoFilter,
  type PromoListState,
} from './promoListState'
import { parseListState, serializeListState } from '../../lib/router/useListState'
import { PROMO_FIELD, promotionProblems } from './promotionForm'

const blank: PromoListState = { q: '', status: '', jenis: '', hal: 1, per: DEFAULT_PAGE_SIZE, ubah: '', baru: false }

describe('promo list URL state', () => {
  it('omits every default from the URL and reads it back', () => {
    expect(serializeListState(PROMO_LIST_SCHEMA, blank)).toEqual({ q: undefined, status: undefined, jenis: undefined, hal: undefined, per: undefined, ubah: undefined, baru: undefined })
    const state = { ...blank, q: 'raya', status: 'terjadwal', jenis: 'bundle', hal: 3, ubah: 'abc' }
    const url = serializeListState(PROMO_LIST_SCHEMA, state)
    expect(url).toMatchObject({ q: 'raya', status: 'terjadwal', jenis: 'bundle', hal: 3, ubah: 'abc' })
    expect(parseListState(PROMO_LIST_SCHEMA, { q: 'raya', status: 'terjadwal', jenis: 'bundle', hal: '3', ubah: 'abc' })).toEqual(state)
  })

  it('drops codes the API does not know, per tab, before they reach the server', () => {
    const pasted = { ...blank, status: 'hantu', jenis: 'bundle', per: 7, hal: -4 }
    expect(normalizePromoList(pasted, 'promotions')).toMatchObject({ status: '', jenis: 'bundle', per: DEFAULT_PAGE_SIZE, hal: 1 })
    // a bundle is not a discount-code type
    expect(normalizePromoList(pasted, 'codes').jenis).toBe('')
  })

  it('builds the server filter: only what is set', () => {
    expect(toPromoFilter(blank)).toEqual({})
    expect(toPromoFilter({ ...blank, q: '  raya ', status: 'berakhir', jenis: 'fixed' })).toEqual({ q: 'raya', status: 'berakhir', type: 'fixed' })
  })

  it('counts the active filters and describes them in plain words', () => {
    expect(activePromoFilterCount(blank)).toBe(0)
    const state = { ...blank, q: 'raya', status: 'terjadwal', jenis: 'tiered' }
    expect(activePromoFilterCount(state)).toBe(3)
    expect(describePromoFilters(state, 'promotions')).toEqual(['Cari: raya', 'Status: Terjadwal', 'Jenis: Bertingkat'])
  })

  it('steps back from an empty page past the end', () => {
    expect(isPastLastPage(3, 0)).toBe(true)
    expect(isPastLastPage(1, 0)).toBe(false)
    expect(clampPage(9, 51, 25)).toBe(3)
    expect(clampPage(2, 0, 25)).toBe(1)
  })
})

describe('promotionProblems', () => {
  const ok: PromotionInput = { name: 'Raya', type: 'percentage', value: 10, isActive: true }

  it('accepts a plain valid promotion', () => {
    expect(promotionProblems(ok)).toEqual([])
  })

  it('asks for a name (quietly: kind required)', () => {
    expect(promotionProblems({ ...ok, name: '  ' })).toEqual([expect.objectContaining({ fieldId: PROMO_FIELD.name, kind: 'required' })])
  })

  it('needs both hours or neither, and not backwards', () => {
    expect(promotionProblems({ ...ok, activeFromHour: '10:00' })[0]).toMatchObject({ fieldId: PROMO_FIELD.hours, message: 'Isi kedua jam aktif atau kosongkan keduanya.' })
    expect(promotionProblems({ ...ok, activeFromHour: '18:00', activeToHour: '10:00' })[0].fieldId).toBe(PROMO_FIELD.hours)
    expect(promotionProblems({ ...ok, activeFromHour: '10:00', activeToHour: '18:00' })).toEqual([])
    expect(promotionProblems({ ...ok, activeFromHour: '', activeToHour: '' })).toEqual([])
  })

  it('checks the tiers: at least one, a valid percentage, no duplicate threshold', () => {
    const tiered = (tiers: Array<{ minSubtotal: number; kind: 'percentage' | 'fixed'; value: number }>): PromotionInput => ({ ...ok, type: 'tiered', tieredConfig: { tiers } })
    expect(promotionProblems(tiered([]))[0].message).toBe('Harus ada minimal 1 tingkat.')
    expect(promotionProblems(tiered([{ minSubtotal: 1, kind: 'percentage', value: 150 }]))[0].fieldId).toBe(PROMO_FIELD.tiers)
    expect(promotionProblems(tiered([{ minSubtotal: 1, kind: 'fixed', value: 5 }, { minSubtotal: 1, kind: 'fixed', value: 9 }]))[0].message).toContain('duplikat')
    expect(promotionProblems(tiered([{ minSubtotal: 1, kind: 'percentage', value: 5 }, { minSubtotal: 2, kind: 'fixed', value: 9 }]))).toEqual([])
  })

  it('checks the bundle: a slot needs products, a positive price, and a product in one slot only', () => {
    const bundle = (slots: Array<{ productKeys: string[]; quantity: number }>, bundlePrice = 100): PromotionInput => ({ ...ok, type: 'bundle', bundleConfig: { slots, bundlePrice } })
    expect(promotionProblems(bundle([{ productKeys: [], quantity: 1 }]))[0].message).toBe('Setiap slot harus punya minimal 1 produk.')
    expect(promotionProblems(bundle([{ productKeys: ['P|M'], quantity: 1 }], 0))[0].message).toBe('Harga paket harus lebih dari 0.')
    expect(promotionProblems(bundle([{ productKeys: ['P|M'], quantity: 1 }, { productKeys: ['P|L'], quantity: 1 }]))).toEqual([])
  })

  it('rejects a negative maximum on BXGY and bundle', () => {
    const bxgy: PromotionInput = { ...ok, type: 'buy_x_get_y', bxgyConfig: { buyQuantity: 1, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100, maxApplications: -1 } }
    expect(promotionProblems(bxgy).map((p) => p.fieldId)).toContain(PROMO_FIELD.maxApplications)
  })
})

describe('codeProblems', () => {
  it('needs a code', () => {
    const base = { code: '', type: 'percentage' as const, value: 5, isActive: true }
    expect(codeProblems(base)).toEqual([expect.objectContaining({ kind: 'required' })])
    expect(codeProblems({ ...base, code: 'HEMAT' })).toEqual([])
  })
})
