import { describe, expect, it } from 'vitest'
import type { SalesStaff } from '@mandalika/api'
import {
  hasSalesStaffErrors,
  initialSalesStaffForm,
  linkOptions,
  releaseSalesStaffInput,
  salesStaffFormErrors,
  salesStaffFormReducer,
  toSalesStaffInput,
} from './salesStaffForm'

const entry = (over: Partial<SalesStaff> = {}): SalesStaff => ({
  id: 's1', name: 'Rina', active: true, outletIds: ['o1'], hiddenOutletCount: 0, canEditDetails: true, updatedAt: '2026-11-27T00:00:00Z', ...over,
})

describe('salesStaffForm', () => {
  it('trims the name in the payload', () => {
    const s = { ...initialSalesStaffForm(null, ['o1', 'o2']), name: '  Rina  ', outletIds: ['o1'] }
    expect(toSalesStaffInput(s)).toEqual({ name: 'Rina', active: true, outletIds: ['o1'], userId: null })
  })
  it('rejects an empty and a 61-character name, accepts 60', () => {
    const base = initialSalesStaffForm(null, ['o1'])
    expect(salesStaffFormErrors({ ...base, name: '   ' }).name).toBe('Nama wajib diisi')
    expect(salesStaffFormErrors({ ...base, name: 'a'.repeat(61) }).name).toBe('Nama maksimal 60 karakter')
    expect(salesStaffFormErrors({ ...base, name: 'a'.repeat(60) }).name).toBeNull()
  })
  it('requires at least one outlet', () => {
    const s = { ...initialSalesStaffForm(null, ['o1', 'o2']), name: 'Rina' }
    const errors = salesStaffFormErrors(s)
    expect(errors.outlets).toBe('Pilih minimal satu outlet')
    expect(hasSalesStaffErrors(errors)).toBe(true)
    expect(hasSalesStaffErrors(salesStaffFormErrors({ ...s, outletIds: ['o1'] }))).toBe(false)
  })
  it('ticks a single covered outlet up front', () => {
    expect(initialSalesStaffForm(null, ['o1']).outletIds).toEqual(['o1'])
    expect(initialSalesStaffForm(null, ['o1', 'o2']).outletIds).toEqual([])
  })
  it('maps "tidak ditautkan" to userId null', () => {
    const linked = initialSalesStaffForm(entry({ user: { id: 'u1', displayName: 'Rina U' } }), ['o1'])
    const cleared = salesStaffFormReducer(linked, { type: 'SET_USER', userId: '' })
    expect(toSalesStaffInput(cleared).userId).toBeNull()
  })
  it('keeps the link of an edited entry when the link is not touched', () => {
    const s = initialSalesStaffForm(entry({ user: { id: 'u1', displayName: 'Rina U' } }), ['o1'])
    expect(toSalesStaffInput(s).userId).toBe('u1')
  })
  it('prefills an empty name from the chosen account, never a typed one', () => {
    const empty = initialSalesStaffForm(null, ['o1'])
    expect(salesStaffFormReducer(empty, { type: 'SET_USER', userId: 'u1', displayName: 'Budi' }).name).toBe('Budi')
    const typed = { ...empty, name: 'Sari' }
    expect(salesStaffFormReducer(typed, { type: 'SET_USER', userId: 'u1', displayName: 'Budi' }).name).toBe('Sari')
  })
  it('toggles outlets on and off', () => {
    const s = initialSalesStaffForm(null, ['o1', 'o2'])
    const on = salesStaffFormReducer(s, { type: 'TOGGLE_OUTLET', id: 'o2' })
    expect(on.outletIds).toEqual(['o2'])
    expect(salesStaffFormReducer(on, { type: 'TOGGLE_OUTLET', id: 'o2' }).outletIds).toEqual([])
  })
  it('release sends the entry values with active false', () => {
    const e = entry({ user: { id: 'u1', displayName: 'Rina U' }, canEditDetails: false })
    expect(releaseSalesStaffInput(e)).toEqual({ name: 'Rina', active: false, outletIds: ['o1'], userId: 'u1' })
    expect(releaseSalesStaffInput(entry()).userId).toBeNull()
  })
  it('link options always include the current account once', () => {
    const cur = { id: 'u1', displayName: 'Rina U' }
    const other = { id: 'u2', displayName: 'Budi' }
    expect(linkOptions([other], cur).map((u) => u.id)).toEqual(['u1', 'u2'])
    expect(linkOptions([cur, other], cur).map((u) => u.id)).toEqual(['u1', 'u2'])
    expect(linkOptions([other], undefined).map((u) => u.id)).toEqual(['u2'])
  })
})
