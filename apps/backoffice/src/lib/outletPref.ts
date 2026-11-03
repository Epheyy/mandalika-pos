/*
 * The outlet scope is global and stays out of the URL (D-69). It is remembered per viewer in localStorage,
 * keyed by user, and checked against the outlet list before it is applied.
 */
interface PrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const outletPrefKey = (userId: string): string => `mandalika.backoffice.outletId.${userId}`

const browserStorage = (): PrefStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // storage blocked
  }
}

export function readOutletPref(userId: string, storage: PrefStorage | null = browserStorage()): string | null {
  try {
    const raw = storage?.getItem(outletPrefKey(userId)) ?? null
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

/** null (all outlets) clears the preference. */
export function writeOutletPref(userId: string, outletId: string | null, storage: PrefStorage | null = browserStorage()): void {
  try {
    if (outletId === null) storage?.removeItem(outletPrefKey(userId))
    else storage?.setItem(outletPrefKey(userId), outletId)
  } catch {
    // A convenience only: a full or blocked store must not break switching outlets.
  }
}

/**
 * The saved outlet if it is still in the list. An empty list proves nothing (the fetch may have failed),
 * so it neither applies nor discards the preference.
 */
export function resolveOutletPref(saved: string | null, outlets: readonly { id: string }[]): { outletId: string | null; stale: boolean } {
  if (saved === null || outlets.length === 0) return { outletId: null, stale: false }
  return outlets.some((o) => o.id === saved) ? { outletId: saved, stale: false } : { outletId: null, stale: true }
}
