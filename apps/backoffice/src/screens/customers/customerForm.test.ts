import { describe, expect, it } from 'vitest'
import type { Customer } from '@mandalika/api'
import { EMPTY_CUSTOMER_FORM, customerBodyOf, customerFormErrors, formOfCustomer, isCustomerFormDirty } from './customerForm'

const customer = { id: 'c1', name: 'Sari', phone: '0812', email: null, birthday: '1990-01-02', notes: undefined } as unknown as Customer

describe('customer form', () => {
  it('opens a customer with empty strings for missing fields', () => {
    expect(formOfCustomer(customer)).toEqual({ name: 'Sari', phone: '0812', email: '', birthday: '1990-01-02', anniversary: '', notes: '' })
  })

  it('is clean until a field differs from the opening values', () => {
    const opened = formOfCustomer(customer)
    expect(isCustomerFormDirty(opened, opened)).toBe(false)
    expect(isCustomerFormDirty({ ...opened, notes: 'x' }, opened)).toBe(true)
    expect(isCustomerFormDirty({ ...opened, notes: 'x' }, { ...opened, notes: 'x' })).toBe(false)
  })

  it('a new customer is clean while empty and dirty once typed in', () => {
    expect(isCustomerFormDirty(EMPTY_CUSTOMER_FORM, EMPTY_CUSTOMER_FORM)).toBe(false)
    expect(isCustomerFormDirty({ ...EMPTY_CUSTOMER_FORM, name: 'A' }, EMPTY_CUSTOMER_FORM)).toBe(true)
  })

  it('lists a blocking error per invalid field', () => {
    const base = { ...EMPTY_CUSTOMER_FORM, name: 'A', phone: '0812-3456-7890' }
    expect(customerFormErrors(base)).toEqual([])
    expect(customerFormErrors({ ...base, name: ' ' }).map((e) => e.fieldId)).toEqual(['customer-name'])
    expect(customerFormErrors({ ...base, phone: ' ' })[0].message).toBe('Nomor telepon wajib diisi')
    expect(customerFormErrors({ ...base, phone: 'abc123' })[0].message).toBe('Nomor telepon tidak valid')
    expect(customerFormErrors({ ...base, email: 'bukan-email' })[0].message).toBe('Format email tidak valid')
    expect(customerFormErrors({ ...base, email: '' })).toEqual([])
    expect(customerFormErrors(EMPTY_CUSTOMER_FORM).map((e) => e.fieldId)).toEqual(['customer-name', 'customer-phone'])
  })

  it('does not re-judge a phone or email left as stored (old rows may predate the rule)', () => {
    const opened = { ...EMPTY_CUSTOMER_FORM, name: 'Lama', phone: '12345', email: 'lama@x' }
    expect(customerFormErrors({ ...opened, notes: 'catatan' }, opened)).toEqual([])
    expect(customerFormErrors({ ...opened, phone: '12346' }, opened)[0].message).toBe('Nomor telepon tidak valid')
    expect(customerFormErrors({ ...opened, email: 'baru@x' }, opened)[0].message).toBe('Format email tidak valid')
  })

  it('accepts foreign numbers', () => {
    for (const phone of ['+65 8123 4567', '+61 412 345 678', '+1 (415) 555-2671', '+44 20 7946 0958']) {
      expect(customerFormErrors({ ...EMPTY_CUSTOMER_FORM, name: 'A', phone })).toEqual([])
    }
  })

  it('trims free text but sends dates as picked', () => {
    expect(customerBodyOf({ ...EMPTY_CUSTOMER_FORM, name: ' A ', phone: ' 0812-3456-7890 ', email: ' a@b.co ', notes: ' n ', birthday: '2000-01-01' })).toEqual({
      name: 'A', phone: '0812-3456-7890', email: 'a@b.co', birthday: '2000-01-01', anniversary: '', notes: 'n',
    })
  })
})
