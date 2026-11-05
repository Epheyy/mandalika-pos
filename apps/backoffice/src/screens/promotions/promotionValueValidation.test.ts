import { describe, expect, it } from 'vitest'
import type { DiscountCodeInput, PromotionInput } from '@mandalika/api'
import { CODE_FIELD, EMPTY_CODE, codeProblems, duplicateCodeMessage, mapCodeSaveError } from './discountCodeForm'
import { EMPTY_PROMO, PROMO_FIELD, promotionProblems } from './promotionForm'

const promo = (over: Partial<PromotionInput>): PromotionInput => ({ ...EMPTY_PROMO, name: 'Promo', ...over })
const code = (over: Partial<DiscountCodeInput>): DiscountCodeInput => ({ ...EMPTY_CODE, code: 'ABC', ...over })
const fields = (ps: { fieldId: string }[]) => ps.map((p) => p.fieldId)

describe('promotionProblems value and dates', () => {
  it('flags a percentage promo with value 0 as required', () => {
    const ps = promotionProblems(promo({ type: 'percentage', value: 0 }))
    expect(ps).toContainEqual(expect.objectContaining({ fieldId: PROMO_FIELD.value, kind: 'required' }))
  })
  it('flags a fixed promo with value 0 or negative', () => {
    expect(fields(promotionProblems(promo({ type: 'fixed', value: 0 })))).toContain(PROMO_FIELD.value)
    expect(fields(promotionProblems(promo({ type: 'fixed', value: -5 })))).toContain(PROMO_FIELD.value)
  })
  it('flags a percentage over 100 as invalid', () => {
    const ps = promotionProblems(promo({ type: 'percentage', value: 101 }))
    expect(ps).toContainEqual(expect.objectContaining({ fieldId: PROMO_FIELD.value, kind: 'invalid' }))
  })
  it('accepts 100% and a positive nominal', () => {
    expect(promotionProblems(promo({ type: 'percentage', value: 100 }))).toEqual([])
    expect(promotionProblems(promo({ type: 'fixed', value: 5000 }))).toEqual([])
  })
  it('ignores the top-level value for bogo', () => {
    expect(promotionProblems(promo({ type: 'bogo', value: 0 }))).toEqual([])
  })
  it('flags an end date before the start date', () => {
    const ps = promotionProblems(promo({ type: 'fixed', value: 1, startDate: '2026-11-02', endDate: '2026-11-01' }))
    expect(fields(ps)).toEqual([PROMO_FIELD.endDate])
  })
  it('allows equal dates and a single date', () => {
    expect(promotionProblems(promo({ type: 'fixed', value: 1, startDate: '2026-11-01', endDate: '2026-11-01' }))).toEqual([])
    expect(promotionProblems(promo({ type: 'fixed', value: 1, endDate: '2026-11-01' }))).toEqual([])
  })
})

describe('codeProblems value and dates', () => {
  it('flags value 0 on an unlinked percentage code', () => {
    expect(fields(codeProblems(code({ type: 'percentage', value: 0 })))).toEqual([CODE_FIELD.value])
  })
  it('flags a percentage over 100 and a non-positive fixed value', () => {
    expect(fields(codeProblems(code({ type: 'percentage', value: 150 })))).toEqual([CODE_FIELD.value])
    expect(fields(codeProblems(code({ type: 'fixed', value: -1 })))).toEqual([CODE_FIELD.value])
  })
  it('skips the value check for a code linked to a promotion', () => {
    expect(codeProblems(code({ type: 'percentage', value: 0, promotionId: 'p1' }))).toEqual([])
  })
  it('flags an end date before the start date', () => {
    const ps = codeProblems(code({ type: 'fixed', value: 1000, startDate: '2026-12-01', endDate: '2026-11-01' }))
    expect(fields(ps)).toEqual([CODE_FIELD.endDate])
  })
  it('still requires the code text', () => {
    expect(codeProblems(code({ code: ' ', type: 'fixed', value: 1000 }))).toContainEqual(expect.objectContaining({ fieldId: CODE_FIELD.code, kind: 'required' }))
  })
})

describe('mapCodeSaveError', () => {
  it('turns the generic conflict into an Indonesian duplicate-code message', () => {
    const e = mapCodeSaveError(new Error('the change conflicts with existing data'), 'abc ')
    expect(e).toEqual(new Error(duplicateCodeMessage('abc ')))
    expect((e as Error).message).toBe('Kode ABC sudah dipakai. Pilih kode lain.')
  })
  it('passes other errors through', () => {
    const other = new Error('boom')
    expect(mapCodeSaveError(other, 'ABC')).toBe(other)
  })
})
