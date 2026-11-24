import type { User } from '@mandalika/api'
import { outletCoverageOf } from '../../lib/outletCoverage'
import type { Role } from './roles'

/**
 * The outlet-coverage choice of the user form. `mode` only matters for a manager; a cashier uses `homeId`
 * alone and an admin keeps whatever home outlet they already have.
 */
export type CoverageValue = { mode: 'all' | 'specific' | 'none'; homeId: string; outletIds: string[] }

type CoverageSource = Pick<User, 'role' | 'outletId'> & Partial<Pick<User, 'outletIds' | 'allOutlets'>>

export const EMPTY_COVERAGE: CoverageValue = { mode: 'specific', homeId: '', outletIds: [] }

/** The form value for an existing user. A manager with no outlet and no All flag opens as 'none' (must choose). */
export function coverageFromUser(u: CoverageSource): CoverageValue {
  const homeId = u.outletId ?? ''
  if (u.role === 'admin') return { mode: 'all', homeId, outletIds: [] }
  if (u.role === 'cashier') return { mode: 'specific', homeId, outletIds: homeId ? [homeId] : [] }
  const cov = outletCoverageOf(u)
  if (cov.allOutlets) return { mode: 'all', homeId: '', outletIds: [] }
  const ids = cov.outletIds.length > 0 ? [...cov.outletIds] : homeId ? [homeId] : []
  if (ids.length === 0) return { mode: 'none', homeId: '', outletIds: [] }
  return { mode: 'specific', homeId: ids.includes(homeId) ? homeId : ids[0], outletIds: ids }
}

/** What blocks saving the coverage choice, or null (mirrors the server's validation). */
export function coverageError(role: Role, v: CoverageValue): string | null {
  if (role === 'admin') return null
  if (role === 'cashier') return v.homeId ? null : 'Pilih satu outlet untuk kasir.'
  if (v.mode === 'all') return null
  if (v.mode === 'none' || v.outletIds.length === 0) return 'Pilih Semua Outlet atau minimal satu outlet.'
  if (!v.outletIds.includes(v.homeId)) return 'Outlet utama harus salah satu outlet yang dicentang.'
  return null
}

/** The three wire fields, always sent in full so a role change never leaves a stale value on the server. */
export function coveragePayload(role: Role, v: CoverageValue): { outletId: string | null; outletIds: string[]; allOutlets: boolean } {
  if (role === 'admin') return { outletId: v.homeId || null, outletIds: [], allOutlets: false }
  if (role === 'cashier') return { outletId: v.homeId || null, outletIds: v.homeId ? [v.homeId] : [], allOutlets: false }
  if (v.mode === 'all') return { outletId: null, outletIds: [], allOutlets: true }
  return { outletId: v.homeId || null, outletIds: [v.homeId, ...v.outletIds.filter((id) => id !== v.homeId)].filter(Boolean), allOutlets: false }
}

/**
 * The value after the role changes: a cashier keeps only the home outlet; a manager starts from the home outlet.
 * A new admin starts with no home outlet, unless `adminHome` restores the original admin's own (edit form).
 */
export function coverageForRole(prev: Role, next: Role, v: CoverageValue, adminHome = ''): CoverageValue {
  if (prev === next) return v
  const homeId = v.mode === 'specific' ? v.homeId || v.outletIds[0] || '' : v.homeId
  if (next === 'admin') return { mode: 'all', homeId: adminHome, outletIds: [] }
  if (next === 'cashier') return { mode: 'specific', homeId, outletIds: homeId ? [homeId] : [] }
  return homeId ? { mode: 'specific', homeId, outletIds: [homeId] } : { mode: 'none', homeId: '', outletIds: [] }
}

/** Tick or untick an outlet; the home outlet moves to the first remaining tick when it is unticked. */
export function toggleOutlet(v: CoverageValue, id: string): CoverageValue {
  const outletIds = v.outletIds.includes(id) ? v.outletIds.filter((x) => x !== id) : [...v.outletIds, id]
  const homeId = outletIds.includes(v.homeId) ? v.homeId : (outletIds[0] ?? '')
  return { mode: 'specific', homeId, outletIds }
}

/** Manager mode switch: 'Semua Outlet' drops the home and the ticks. */
export function setCoverageMode(v: CoverageValue, mode: 'all' | 'specific'): CoverageValue {
  if (mode === 'all') return { mode, homeId: '', outletIds: [] }
  return { mode, homeId: v.homeId, outletIds: v.outletIds }
}

/** The Outlet column of the user list. */
export function outletLabel(u: CoverageSource, nameOf: (id: string) => string): string {
  const cov = outletCoverageOf(u)
  if (cov.allOutlets) return 'Semua Outlet'
  if (u.role === 'admin') return u.outletId ? nameOf(u.outletId) : 'Semua Outlet'
  const ids = cov.outletIds
  if (ids.length === 0) return 'Belum ada outlet'
  const home = u.outletId && ids.includes(u.outletId) ? u.outletId : ids[0]
  return ids.length >= 2 ? `${nameOf(home)} +${ids.length - 1}` : nameOf(home)
}
