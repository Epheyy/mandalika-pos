import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Outlet } from '@mandalika/api'
import { activeOutletOf, coveredOutlets, outletCoverageOf, restoreChoice } from './outletCoverage'
import { resolveOutletPref } from './outletPref'
import { OutletSwitcherView } from '../outlet'

const A = { id: 'A', name: 'Outlet A' } as Outlet
const B = { id: 'B', name: 'Outlet B' } as Outlet
const C = { id: 'C', name: 'Outlet C' } as Outlet
const all = [A, B, C]

const mgr = (outletIds: string[], allOutlets = false, outletId: string | null = outletIds[0] ?? null) => ({
  role: 'manager' as const,
  outletId,
  outletIds,
  allOutlets,
})

function switcher(user: Parameters<typeof outletCoverageOf>[0], list: Outlet[] = all, selected = '') {
  const cov = outletCoverageOf(user)
  const outlets = coveredOutlets(list, cov, user?.role === 'admin')
  return renderToStaticMarkup(
    <OutletSwitcherView show={cov.canSwitch} outlets={outlets} selected={selected} allowCombined={cov.allowCombined} onChange={() => {}} />,
  )
}

describe('outletCoverageOf', () => {
  it('cashier and one-outlet manager cannot switch', () => {
    expect(outletCoverageOf({ role: 'cashier', outletId: 'A', outletIds: ['A'], allOutlets: false }).canSwitch).toBe(false)
    expect(outletCoverageOf(mgr(['A'])).canSwitch).toBe(false)
  })
  it('a two-outlet manager switches but has no combined view', () => {
    expect(outletCoverageOf(mgr(['A', 'B']))).toMatchObject({ canSwitch: true, allowCombined: false })
  })
  it('admin and an All manager switch and may combine', () => {
    expect(outletCoverageOf({ role: 'admin', outletId: null, outletIds: [], allOutlets: false })).toMatchObject({ canSwitch: true, allowCombined: true })
    expect(outletCoverageOf(mgr([], true, null))).toMatchObject({ canSwitch: true, allowCombined: true })
  })
  it('an unassigned manager cannot switch', () => {
    expect(outletCoverageOf(mgr([], false, null)).canSwitch).toBe(false)
  })
  it('a stored user without the new fields falls back to the home outlet and allOutlets=false', () => {
    const old = { role: 'manager' as const, outletId: 'A' }
    expect(outletCoverageOf(old)).toEqual({ outletIds: ['A'], allOutlets: false, canSwitch: false, allowCombined: false })
    expect(outletCoverageOf({ role: 'manager', outletId: null }).outletIds).toEqual([])
  })
})

describe('OutletSwitcherView', () => {
  it('is hidden for a cashier and a one-outlet manager', () => {
    expect(switcher({ role: 'cashier', outletId: 'A', outletIds: ['A'], allOutlets: false })).toBe('')
    expect(switcher(mgr(['A']))).toBe('')
  })
  it('lists exactly the covered outlets and no "Semua outlet" for manager [A,B]', () => {
    const html = switcher(mgr(['A', 'B']), all, 'A')
    expect(html).toContain('Outlet A')
    expect(html).toContain('Outlet B')
    expect(html).not.toContain('Outlet C')
    expect(html).not.toContain('Semua outlet')
  })
  it('shows every outlet plus "Semua outlet" for an All manager', () => {
    const html = switcher(mgr([], true, null))
    expect(html).toContain('Semua outlet')
    for (const n of ['Outlet A', 'Outlet B', 'Outlet C']) expect(html).toContain(n)
  })
})

describe('remembered outlet outside coverage', () => {
  it('manager [A,B] with remembered C drops it: no header, falls back to home A', () => {
    const user = mgr(['A', 'B'])
    const covered = coveredOutlets(all, outletCoverageOf(user), false)
    expect(resolveOutletPref('C', covered)).toEqual({ outletId: null, stale: true })
    expect(activeOutletOf(null, user)).toBe('A')
  })
  it('keeps a remembered covered outlet', () => {
    const covered = coveredOutlets(all, outletCoverageOf(mgr(['A', 'B'])), false)
    expect(resolveOutletPref('B', covered)).toEqual({ outletId: 'B', stale: false })
  })
})

describe('activeOutletOf', () => {
  it('returns the switcher choice, else the home outlet', () => {
    expect(activeOutletOf('B', mgr(['A', 'B']))).toBe('B')
    expect(activeOutletOf(null, mgr(['A', 'B']))).toBe('A')
    expect(activeOutletOf(null, null)).toBeNull()
  })
  it('stays combined (null) for admin and an All manager with no choice', () => {
    expect(activeOutletOf(null, { role: 'admin', outletId: null })).toBeNull()
    expect(activeOutletOf(null, mgr([], true, null))).toBeNull()
  })
})

describe('restoreChoice (provider path when the outlet list arrives)', () => {
  it('manager [A,B] with saved C: outlets A,B, no choice, stale', () => {
    const r = restoreChoice(mgr(['A', 'B']), all, 'C')
    expect(r.outlets.map((o) => o.id)).toEqual(['A', 'B'])
    expect(r.outletId).toBeNull()
    expect(r.stale).toBe(true)
  })
  it('manager [A,B] with saved B keeps B', () => {
    expect(restoreChoice(mgr(['A', 'B']), all, 'B')).toMatchObject({ outletId: 'B', stale: false })
  })
  it('admin with saved C (exists) keeps C and sees every outlet', () => {
    const r = restoreChoice({ role: 'admin' as const, outletId: null }, all, 'C')
    expect(r.outletId).toBe('C')
    expect(r.outlets).toHaveLength(3)
  })
})

describe('activeOutletOf with no choice', () => {
  it('admin with a home outlet stays combined (null)', () => {
    expect(activeOutletOf(null, { role: 'admin', outletId: 'A' })).toBeNull()
  })
  it('covered manager falls back to home', () => {
    expect(activeOutletOf(null, mgr(['B', 'A'], false, 'B'))).toBe('B')
  })
})
