import type { Customer } from '@mandalika/api'

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

/** Why the form cannot be saved yet, or null. */
export function customerFormProblem(form: CustomerForm): string | null {
  return !form.name.trim() || !form.phone.trim() ? 'Nama & telepon wajib diisi' : null
}
