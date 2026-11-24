import type { User } from '@mandalika/api'
import { resolveOutletPref } from './outletPref'

export interface OutletCoverage {
  /** Outlets the user may act in (home first). Empty for admin, an All manager and an unassigned manager. */
  outletIds: readonly string[]
  /** True only for a manager covering every outlet. */
  allOutlets: boolean
  /** May pick an outlet in the switcher. */
  canSwitch: boolean
  /** May view the combined (no X-Outlet-Id) scope. */
  allowCombined: boolean
}

type CoverageUser = Pick<User, 'role' | 'outletId'> & Partial<Pick<User, 'outletIds' | 'allOutlets'>>

/**
 * The one reader of the coverage fields. A user restored from an older stored session may lack them:
 * missing outletIds falls back to the home outlet, missing allOutlets to false.
 */
export function outletCoverageOf(user: CoverageUser | null | undefined): OutletCoverage {
  if (!user) return { outletIds: [], allOutlets: false, canSwitch: false, allowCombined: false }
  const outletIds = user.outletIds ?? (user.outletId ? [user.outletId] : [])
  const allOutlets = user.allOutlets ?? false
  const isAdmin = user.role === 'admin'
  return {
    outletIds,
    allOutlets,
    canSwitch: isAdmin || allOutlets || outletIds.length >= 2,
    allowCombined: isAdmin || allOutlets,
  }
}

/** Admin and an All manager see every outlet; a covered manager only theirs (the server is the real guard). */
export function coveredOutlets<T extends { id: string }>(list: readonly T[], cov: OutletCoverage, isAdmin: boolean): T[] {
  if (isAdmin || cov.allOutlets) return [...list]
  return list.filter((o) => cov.outletIds.includes(o.id))
}

/**
 * What the provider does when the outlet list arrives: keep only the covered outlets and resolve the remembered
 * choice against them, so a remembered outlet outside coverage is dropped (stale) and never sent as a header.
 */
export function restoreChoice<T extends { id: string }>(
  user: CoverageUser | null | undefined,
  list: readonly T[],
  savedPref: string | null,
): { outlets: T[]; outletId: string | null; stale: boolean } {
  const outlets = coveredOutlets(list, outletCoverageOf(user), user?.role === 'admin')
  return { outlets, ...resolveOutletPref(savedPref, outlets) }
}

/**
 * The outlet requests are scoped to: the switcher choice, else the user's home outlet. For admin / All manager
 * with no choice it is null (the combined view), as the server treats a missing X-Outlet-Id for them.
 */
export function activeOutletOf(chosen: string | null, user: CoverageUser | null | undefined): string | null {
  if (chosen) return chosen
  return outletCoverageOf(user).allowCombined ? null : (user?.outletId ?? null)
}
