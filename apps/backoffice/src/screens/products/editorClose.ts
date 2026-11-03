import { parseHash } from '../../lib/router/hash'

/**
 * Closing the editor steps back to the list entry it was opened from, so one Back press leaves the list as it was
 * (Forward reopens the editor, like any history entry). That only holds when the entry before is the same list without an overlay;
 * a pasted `?ubah=` link or a reload has no such entry, and the overlay is replaced away instead.
 */
export function openedFromList(previousHash: string | undefined, nowPath: readonly string[]): boolean {
  if (previousHash === undefined) return false
  const prev = parseHash(previousHash)
  const samePath = prev.path.length === nowPath.length && prev.path.every((s, i) => s === nowPath[i])
  return samePath && prev.query.ubah === undefined && prev.query.baru === undefined
}
