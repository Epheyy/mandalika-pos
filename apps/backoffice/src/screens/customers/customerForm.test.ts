import { describe, expect, it } from 'vitest'
import type { Customer } from '@mandalika/api'
import { EMPTY_CUSTOMER_FORM, customerBodyOf, customerFormProblem, formOfCustomer, isCustomerFormDirty } from './customerForm'

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

  it('requires a name and a phone that are not blank', () => {
    expect(customerFormProblem({ ...EMPTY_CUSTOMER_FORM, name: ' ', phone: '1' })).toBe('Nama & telepon wajib diisi')
    expect(customerFormProblem({ ...EMPTY_CUSTOMER_FORM, name: 'A', phone: ' ' })).toBe('Nama & telepon wajib diisi')
    expect(customerFormProblem({ ...EMPTY_CUSTOMER_FORM, name: 'A', phone: '1' })).toBeNull()
  })

  it('trims free text but sends dates as picked', () => {
    expect(customerBodyOf({ ...EMPTY_CUSTOMER_FORM, name: ' A ', phone: ' 1 ', email: ' a@b ', notes: ' n ', birthday: '2000-01-01' })).toEqual({
      name: 'A', phone: '1', email: 'a@b', birthday: '2000-01-01', anniversary: '', notes: 'n',
    })
  })
})
