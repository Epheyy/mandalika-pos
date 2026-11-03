import type { DiscountCode, DiscountCodeBatchInput, DiscountCodeInput } from '@mandalika/api'
import type { FormProblem } from './promotionForm'

export const CODE_FIELD = { code: 'code-code' } as const

export const EMPTY_CODE: DiscountCodeInput = {
  code: '', type: 'percentage', value: 0, minPurchase: 0, usageLimit: 0, perCustomerLimit: undefined,
  isActive: true, combinable: false, promotionId: undefined, customerId: undefined,
}

export const EMPTY_BATCH: DiscountCodeBatchInput = {
  count: 10, prefix: '', suffixLength: 6, type: 'percentage', value: 0, minPurchase: 0,
  usageLimit: 1, perCustomerLimit: undefined, isActive: true, combinable: false, promotionId: undefined,
}

/**
 * The editable form of a stored code. Every field of DiscountCodeInput is carried and nulls stay null (the old
 * "|| 0" turned an unlimited quota into 0). The holder's display name is not part of the input: the form keeps it
 * next to the id. The code text goes back exactly as stored; it is upper-cased only as the user types it.
 */
export function codeToInput(c: DiscountCode): DiscountCodeInput {
  return {
    code: c.code,
    promotionId: c.promotionId ?? undefined,
    type: c.type,
    value: c.value,
    minPurchase: c.minPurchase ?? null,
    usageLimit: c.usageLimit ?? null,
    perCustomerLimit: c.perCustomerLimit ?? null,
    customerId: c.customerId ?? null,
    isActive: c.isActive,
    startDate: c.startDate ?? undefined,
    endDate: c.endDate ?? undefined,
    combinable: c.combinable ?? null,
  }
}

export function codeProblems(form: DiscountCodeInput): FormProblem[] {
  if (form.code.trim()) return []
  return [{ fieldId: CODE_FIELD.code, label: 'Kode', message: 'Kode wajib diisi.', kind: 'required' }]
}
