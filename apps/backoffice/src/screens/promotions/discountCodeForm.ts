import type { DiscountCode, DiscountCodeBatchInput, DiscountCodeInput } from '@mandalika/api'
import { dateOrderProblem, discountValueProblem, type FormProblem } from './promotionForm'

export const CODE_FIELD = { code: 'code-code', value: 'code-value', endDate: 'code-end-date' } as const

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

/** The server's duplicate-code refusal is a generic English "conflicts with existing data"; name the code instead. */
export function duplicateCodeMessage(code: string): string {
  return `Kode ${code.trim().toUpperCase()} sudah dipakai. Pilih kode lain.`
}

/** Re-throws a save failure with the duplicate-code case in Indonesian; any other error passes through unchanged. */
export function mapCodeSaveError(e: unknown, code: string): unknown {
  if (e instanceof Error && /conflicts with existing data/i.test(e.message)) return new Error(duplicateCodeMessage(code))
  return e
}

export function codeProblems(form: DiscountCodeInput): FormProblem[] {
  const out: FormProblem[] = []
  if (!form.code.trim()) out.push({ fieldId: CODE_FIELD.code, label: 'Kode', message: 'Kode wajib diisi.', kind: 'required' })
  // A code linked to a promotion follows its type and value (the fields are disabled), so only an unlinked code is checked.
  if (!form.promotionId) {
    const v = discountValueProblem(form.type, form.value, CODE_FIELD.value, 'Nilai')
    if (v) out.push(v)
  }
  const d = dateOrderProblem(form.startDate, form.endDate, CODE_FIELD.endDate)
  if (d) out.push(d)
  return out
}
