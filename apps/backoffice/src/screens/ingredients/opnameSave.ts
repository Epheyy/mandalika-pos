/**
 * "Simpan" sends only the lines the operator entered in the current draft. The server updates exactly the lines it is
 * sent and leaves the rest as stored, so an ingredient nobody counted stays NULL and is skipped by "Selesai"
 * (sending 0 for it would zero its stock on completion).
 */
export function buildIngredientCountSaveItems(
  items: ReadonlyArray<{ id: string }>,
  draft: Readonly<Record<string, number>>,
): { itemId: string; counted: number }[] {
  return items.flatMap((it) => (draft[it.id] === undefined ? [] : [{ itemId: it.id, counted: draft[it.id] }]))
}

/** A cleared box is "not counted" (null) and a count is never negative; "-" or other half-typed text is not a count either. */
export function parseCountInput(raw: string): number | null {
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? Math.max(0, n) : null
}

/** Sets one draft entry; null drops it so the line goes back to its saved value (or uncounted). */
export function withCountEntry(draft: Readonly<Record<string, number>>, itemId: string, val: number | null): Record<string, number> {
  const { [itemId]: _dropped, ...rest } = draft
  return val === null ? rest : { ...rest, [itemId]: val }
}

/** After a save, drops only the entries that were sent and have not been edited since (the box may change while the request is in flight). */
export function withoutSavedEntries(
  draft: Readonly<Record<string, number>>,
  sent: ReadonlyArray<{ itemId: string; counted: number }>,
): Record<string, number> {
  const next = { ...draft }
  for (const s of sent) if (next[s.itemId] === s.counted) delete next[s.itemId]
  return next
}

/**
 * How many typed-but-unsaved rows the operator would lose by leaving. Counts every draft entry (zero is a count),
 * except those of a listed count that is no longer running: it can't be saved to anymore, so nothing is at stake.
 */
export function unsavedEntryCount(
  draft: Readonly<Record<string, Readonly<Record<string, number>>>>,
  counts: ReadonlyArray<{ id: string; status: string }>,
): number {
  const statusOf = new Map(counts.map((c) => [c.id, c.status]))
  let rows = 0
  for (const [countId, entries] of Object.entries(draft)) {
    const status = statusOf.get(countId)
    if (status !== undefined && status !== 'in_progress') continue
    rows += Object.keys(entries).length
  }
  return rows
}
