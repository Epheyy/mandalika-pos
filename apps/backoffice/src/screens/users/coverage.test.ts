import { describe, expect, it } from 'vitest'
import { coverageError, coverageForRole, coverageFromUser, coveragePayload, outletLabel, setCoverageMode, toggleOutlet, type CoverageValue } from './coverage'

const name = (id: string) => ({ a: 'Alpha', b: 'Beta', c: 'Gamma' })[id] ?? id
const u = (role: string, outletId: string | null, outletIds: string[], allOutlets = false) => ({ role, outletId, outletIds, allOutlets }) as never

describe('coverageFromUser', () => {
  it('reads each role', () => {
    expect(coverageFromUser(u('cashier', 'a', ['a']))).toEqual({ mode: 'specific', homeId: 'a', outletIds: ['a'] })
    expect(coverageFromUser(u('manager', null, [], true))).toEqual({ mode: 'all', homeId: '', outletIds: [] })
    expect(coverageFromUser(u('manager', 'b', ['b', 'a']))).toEqual({ mode: 'specific', homeId: 'b', outletIds: ['b', 'a'] })
    expect(coverageFromUser(u('admin', 'a', []))).toEqual({ mode: 'all', homeId: 'a', outletIds: [] })
  })
  it('opens an unassigned manager as none', () => {
    expect(coverageFromUser(u('manager', null, []))).toEqual({ mode: 'none', homeId: '', outletIds: [] })
  })
  it('falls back to the home outlet for an older payload', () => {
    expect(coverageFromUser({ role: 'manager', outletId: 'a' } as never)).toEqual({ mode: 'specific', homeId: 'a', outletIds: ['a'] })
  })
})

describe('coverageError', () => {
  const spec = (homeId: string, outletIds: string[]): CoverageValue => ({ mode: 'specific', homeId, outletIds })
  it('cashier needs a home', () => {
    expect(coverageError('cashier', spec('', []))).toBe('Pilih satu outlet untuk kasir.')
    expect(coverageError('cashier', spec('a', ['a']))).toBeNull()
  })
  it('manager needs All or a ticked outlet with a ticked home', () => {
    const msg = 'Pilih Semua Outlet atau minimal satu outlet.'
    expect(coverageError('manager', { mode: 'none', homeId: '', outletIds: [] })).toBe(msg)
    expect(coverageError('manager', spec('', []))).toBe(msg)
    expect(coverageError('manager', spec('c', ['a', 'b']))).toBe('Outlet utama harus salah satu outlet yang dicentang.')
    expect(coverageError('manager', spec('a', ['a', 'b']))).toBeNull()
    expect(coverageError('manager', { mode: 'all', homeId: '', outletIds: [] })).toBeNull()
  })
  it('admin is never blocked', () => {
    expect(coverageError('admin', spec('', []))).toBeNull()
  })
})

describe('coveragePayload', () => {
  it('builds the full triple per role', () => {
    expect(coveragePayload('cashier', { mode: 'specific', homeId: 'a', outletIds: ['a', 'b'] })).toEqual({ outletId: 'a', outletIds: ['a'], allOutlets: false })
    expect(coveragePayload('manager', { mode: 'all', homeId: 'a', outletIds: ['a'] })).toEqual({ outletId: null, outletIds: [], allOutlets: true })
    expect(coveragePayload('manager', { mode: 'specific', homeId: 'b', outletIds: ['a', 'b', 'c'] })).toEqual({ outletId: 'b', outletIds: ['b', 'a', 'c'], allOutlets: false })
  })
  it('admin keeps its current home outlet, else null', () => {
    expect(coveragePayload('admin', { mode: 'all', homeId: 'a', outletIds: [] })).toEqual({ outletId: 'a', outletIds: [], allOutlets: false })
    expect(coveragePayload('admin', { mode: 'all', homeId: '', outletIds: [] })).toEqual({ outletId: null, outletIds: [], allOutlets: false })
  })
})

describe('role change and ticking', () => {
  it('Manajer to Kasir keeps only the home outlet', () => {
    const mgr: CoverageValue = { mode: 'specific', homeId: 'b', outletIds: ['a', 'b'] }
    expect(coverageForRole('manager', 'cashier', mgr)).toEqual({ mode: 'specific', homeId: 'b', outletIds: ['b'] })
  })
  it('Kasir to Manajer starts from the home outlet; an All or empty source needs a choice', () => {
    expect(coverageForRole('cashier', 'manager', { mode: 'specific', homeId: 'a', outletIds: ['a'] })).toEqual({ mode: 'specific', homeId: 'a', outletIds: ['a'] })
    expect(coverageForRole('admin', 'manager', { mode: 'all', homeId: '', outletIds: [] })).toEqual({ mode: 'none', homeId: '', outletIds: [] })
  })
  it('unticking the home outlet moves utama to the first remaining tick', () => {
    const v: CoverageValue = { mode: 'specific', homeId: 'b', outletIds: ['a', 'b', 'c'] }
    expect(toggleOutlet(v, 'b')).toEqual({ mode: 'specific', homeId: 'a', outletIds: ['a', 'c'] })
    expect(toggleOutlet({ mode: 'specific', homeId: 'a', outletIds: ['a'] }, 'a').homeId).toBe('')
  })
  it('the first tick becomes utama', () => {
    expect(toggleOutlet({ mode: 'specific', homeId: '', outletIds: [] }, 'c')).toEqual({ mode: 'specific', homeId: 'c', outletIds: ['c'] })
  })
  it('switching to Semua Outlet clears home and ticks', () => {
    expect(setCoverageMode({ mode: 'specific', homeId: 'a', outletIds: ['a'] }, 'all')).toEqual({ mode: 'all', homeId: '', outletIds: [] })
  })
})

describe('outletLabel', () => {
  it('labels each case', () => {
    expect(outletLabel(u('manager', null, [], true), name)).toBe('Semua Outlet')
    expect(outletLabel(u('admin', null, []), name)).toBe('Semua Outlet')
    expect(outletLabel(u('admin', 'a', []), name)).toBe('Alpha')
    expect(outletLabel(u('manager', 'b', ['b', 'a', 'c']), name)).toBe('Beta +2')
    expect(outletLabel(u('cashier', 'a', ['a']), name)).toBe('Alpha')
    expect(outletLabel(u('manager', null, []), name)).toBe('Belum ada outlet')
  })
})
