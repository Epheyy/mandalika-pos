import { describe, expect, it } from 'vitest'
import type { Outlet } from '@mandalika/api'
import { isValidOutletCode, outletFormBody, outletOrderPrefix, outletToggleBody } from './outletBody'

const outlet = (over: Partial<Outlet> = {}): Outlet =>
  ({ id: 'o1', name: 'Makassar', code: 'MKS', address: 'Jl. A', phone: '1', logoUrl: null, isActive: true, timezone: 'Asia/Makassar', createdAt: '2026-01-01T00:00:00Z', ...over }) as Outlet

describe('outletFormBody', () => {
  it('sends the timezone picked in the form', () => {
    const body = outletFormBody(
      { name: ' Jayapura ', code: 'JYP', address: ' ', phone: '', isActive: true, logoUrl: undefined, timezone: 'Asia/Jayapura' },
      'JYP',
    )
    expect(body).toEqual({ name: 'Jayapura', code: 'JYP', address: '', phone: '', isActive: true, logoUrl: null, timezone: 'Asia/Jayapura' })
  })
})

describe('outletFormBody without a timezone', () => {
  it('omits the key', () => {
    const body = outletFormBody({ name: 'A', code: 'AA', address: '', phone: '', isActive: true, logoUrl: undefined, timezone: undefined }, 'AA')
    expect('timezone' in body).toBe(false)
  })
})

describe('outletToggleBody', () => {
  it('keeps the outlet timezone when only the active flag flips', () => {
    expect(outletToggleBody(outlet())).toMatchObject({ isActive: false, timezone: 'Asia/Makassar' })
  })
  it('omits the timezone key for an older cached outlet without one (server keeps its zone)', () => {
    const body = outletToggleBody(outlet({ timezone: undefined as unknown as Outlet['timezone'] }))
    expect('timezone' in body).toBe(false)
  })
})

describe('isValidOutletCode', () => {
  it.each(['BSD', 'SENTUL', 'TSM-CBB', 'KARAWACI', 'A1', 'A'.repeat(20)])('accepts %s', (c) => {
    expect(isValidOutletCode(c)).toBe(true)
  })
  it.each(['A', '-AB', 'AB-', 'AB CD', 'A'.repeat(21), ''])('rejects %j', (c) => {
    expect(isValidOutletCode(c)).toBe(false)
  })
})

describe('outletOrderPrefix', () => {
  it.each([['TSM-CBB', 'TSMC'], ['SENTUL', 'SENT'], ['BSD', 'BSD'], ['', 'JKT']])('%j -> %s', (c, p) => {
    expect(outletOrderPrefix(c)).toBe(p)
  })
})
