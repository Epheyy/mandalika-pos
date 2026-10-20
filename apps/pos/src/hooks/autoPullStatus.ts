// Pure helpers for how the POS shows background pulls (auto-pull plan 4).

/** The sync button/chip is busy for a manual sync and for any engine pull, automatic or not. */
export function isResyncingNow(manualResyncing: boolean, enginePulling: boolean): boolean {
  return manualResyncing || enginePulling
}

/** The ISO time to store as "last synced" when the engine applied a pull newer than `storedIso`, else null. */
export function nextLastSyncedAt(storedIso: string | null, pulledAtMs: number | null): string | null {
  if (pulledAtMs === null) return null
  const stored = storedIso === null ? NaN : Date.parse(storedIso)
  if (!Number.isNaN(stored) && stored >= pulledAtMs) return null
  return new Date(pulledAtMs).toISOString()
}
