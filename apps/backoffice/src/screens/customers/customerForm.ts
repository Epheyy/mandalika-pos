import type { Customer } from '@mandalika/api'
import { emailProblem, phoneProblem } from '@mandalika/types'

/** The customer edit form. Every field is text, so "changed" is a plain comparison with the opening values. */
export interface CustomerForm {
  name: string
  phone: string
  email: string
  birthday: string
  anniversary: string
  notes: string
}

export const EMPTY_CUSTOMER_FORM: CustomerForm = { name: '', phone: '', email: '', birthday: '', anniversary: '', notes: '' }

export function formOfCustomer(c: Customer): CustomerForm {
  return {
    name: c.name,
    phone: c.phone,
    email: c.email || '',
    birthday: c.birthday || '',
    anniversary: c.anniversary || '',
    notes: c.notes || '',
  }
}

/** Unsaved work: any field differs from the values the panel opened with (a new customer opens empty). */
export function isCustomerFormDirty(form: CustomerForm, opened: CustomerForm): boolean {
  return (Object.keys(opened) as (keyof CustomerForm)[]).some((k) => form[k] !== opened[k])
}

/** The write body: free text is trimmed; dates are sent as picked. */
export function customerBodyOf(form: CustomerForm): CustomerForm {
  return {
    name: form.name.trim(),
    phone: form.phone.trim(),
    email: form.email.trim(),
    birthday: form.birthday,
    anniversary: form.anniversary,
    notes: form.notes.trim(),
  }
}

export const CUSTOMER_FIELD_ID = { name: 'customer-name', phone: 'customer-phone', email: 'customer-email' } as const

export interface CustomerFormError {
  fieldId: string
  /** Short text for the summary at the top of the panel. */
  label: string
  /** Text under the field itself. */
  message: string
}

/** Everything that blocks a save, one entry per field: name, phone (Indonesian or international) and email. */
export function customerFormErrors(form: CustomerForm, opened?: CustomerForm): CustomerFormError[] {
  const errors: CustomerFormError[] = []
  if (!form.name.trim()) errors.push({ fieldId: CUSTOMER_FIELD_ID.name, label: 'Nama wajib diisi', message: 'Nama wajib diisi' })
  // A phone or email left as stored is not re-judged (old rows may predate the rule); only an edit is.
  const phone = opened && form.phone.trim() === opened.phone.trim() && opened.phone.trim() !== '' ? null : phoneProblem(form.phone)
  if (phone) errors.push({ fieldId: CUSTOMER_FIELD_ID.phone, label: phone, message: phone })
  const email = opened && form.email.trim() === opened.email.trim() ? null : emailProblem(form.email)
  if (email) errors.push({ fieldId: CUSTOMER_FIELD_ID.email, label: email, message: email })
  return errors
}
