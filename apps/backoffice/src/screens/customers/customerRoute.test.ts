import { describe, expect, it } from 'vitest'
import { parseListState } from '../../lib/router/useListState'
import {
  CUSTOMER_LIST_SCHEMA,
  REMINDER_LIST_SCHEMA,
  customerHash,
  customerListHash,
  customerPlace,
  dupReviewHash,
  idOf,
  isListPath,
  loyaltyHash,
  pageOf,
  pageSizeOf,
  reminderTypeOf,
  reminderWindowOf,
  sortOf,
} from './customerRoute'

const ID = '00000000-0000-4000-8f6b-0000000000c1'

describe('customerPlace', () => {
  it('names a customer under the list or the reminders, and for a bare id', () => {
    expect(customerPlace(['pelanggan', 'daftar', ID], 'daftar').customerId).toBe(ID)
    expect(customerPlace(['pelanggan', 'pengingat', ID], 'pengingat').customerId).toBe(ID)
    expect(customerPlace(['pelanggan', ID], 'daftar').customerId).toBe(ID)
  })
  it('names the duplicate under review and the loyalty sub-view', () => {
    expect(customerPlace(['pelanggan', 'duplikat', ID], 'duplikat').dupId).toBe(ID)
    expect(customerPlace(['pelanggan', 'loyalitas', 'kondisi'], 'loyalitas').loyaltySub).toBe('conditions')
    expect(customerPlace(['pelanggan', 'loyalitas'], 'loyalitas').loyaltySub).toBe('general')
  })
  it('ignores an id that is not a uuid and ids on tabs that take none', () => {
    expect(customerPlace(['pelanggan', 'daftar', '../x'], 'daftar').customerId).toBeNull()
    expect(customerPlace(['pelanggan', 'duplikat', 'abc'], 'duplikat').dupId).toBeNull()
    expect(customerPlace(['pelanggan', 'loyalitas', ID], 'loyalitas').customerId).toBeNull()
    expect(customerPlace(['pelanggan', 'duplikat', ID], 'duplikat').customerId).toBeNull()
    expect(customerPlace(['pelanggan'], 'daftar')).toEqual({ customerId: null, dupId: null, loyaltySub: 'general' })
  })
})

describe('hashes', () => {
  it('builds the canonical paths', () => {
    expect(customerListHash('pengingat')).toBe('#/pelanggan/pengingat')
    expect(customerHash('daftar', ID)).toBe(`#/pelanggan/daftar/${ID}`)
    expect(dupReviewHash(ID)).toBe(`#/pelanggan/duplikat/${ID}`)
    expect(loyaltyHash('conditions')).toBe('#/pelanggan/loyalitas/kondisi')
    expect(loyaltyHash('general')).toBe('#/pelanggan/loyalitas')
  })
  it('isListPath is true only where the list itself shows', () => {
    expect(isListPath(['pelanggan'], 'daftar')).toBe(true)
    expect(isListPath(['pelanggan', 'daftar'], 'daftar')).toBe(true)
    expect(isListPath(['pelanggan', 'daftar', ID], 'daftar')).toBe(false)
    expect(isListPath(['pelanggan', ID], 'daftar')).toBe(false)
    expect(isListPath(['pelanggan', 'pengingat'], 'pengingat')).toBe(true)
    expect(isListPath(['pelanggan', 'pengingat'], 'daftar')).toBe(false)
    expect(isListPath(['pelanggan', 'duplikat', ID], 'duplikat')).toBe(false)
    expect(isListPath(['produk'], 'daftar')).toBe(false)
  })
})

describe('filter normalisers', () => {
  it('fall back to the default for junk', () => {
    expect(pageOf(-3)).toBe(1)
    expect(pageOf(0)).toBe(1)
    expect(pageOf(2.9)).toBe(2)
    expect(pageOf(Number.NaN)).toBe(1)
    expect(pageSizeOf(7)).toBe(25)
    expect(pageSizeOf(100)).toBe(100)
    expect(sortOf('zzz')).toBe('belanja')
    expect(sortOf('terbaru')).toBe('terbaru')
    expect(idOf('nope')).toBe('')
    expect(idOf(ID)).toBe(ID)
    expect(reminderWindowOf(5)).toBe(7)
    expect(reminderWindowOf(30)).toBe(30)
    expect(reminderTypeOf('x')).toBe('all')
    expect(reminderTypeOf('birthday')).toBe('birthday')
  })
  it('read from a query with defaults implicit', () => {
    expect(parseListState(CUSTOMER_LIST_SCHEMA, {})).toEqual({ q: '', urut: 'belanja', tag: '', segmen: '', hal: 1, per: 25 })
    expect(parseListState(CUSTOMER_LIST_SCHEMA, { q: 'sari', urut: 'terbaru', hal: '2' }).hal).toBe(2)
    expect(parseListState(REMINDER_LIST_SCHEMA, { hari: '30', jenis: 'birthday' })).toEqual({ hari: 30, jenis: 'birthday', hal: 1 })
  })
})
