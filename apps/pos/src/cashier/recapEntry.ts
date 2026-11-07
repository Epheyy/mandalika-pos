/** Highest note count one denomination row accepts. */
export const MAX_NOTE_COUNT = 9999

/**
 * Terhitung map after the cashier edits one method's field. `raw` is the digit string the shared cash field
 * (cashInput.ts) keeps: '' clears the method (not counted yet), '0' counts zero, anything else is that whole-rupiah amount.
 * Returns a new map; the previous one is never touched.
 */
export function withCountedRaw(prev: Readonly<Record<string, number>>, id: string, raw: string): Record<string, number> {
  const rest = Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id))
  return raw === '' ? rest : { ...rest, [id]: Number(raw) }
}

/** The raw digit string the field shows for a method: '' until it has a count. */
export function countedRaw(counted: Readonly<Record<string, number>>, id: string): string {
  return counted[id] === undefined ? '' : String(counted[id])
}

/** A note count typed into a denomination row: digits only (no Rp), whole, 0..MAX_NOTE_COUNT. */
export function parseNoteCount(text: string): number {
  return Math.min(MAX_NOTE_COUNT, Number(text.replace(/\D/g, '').slice(0, 9)) || 0)
}
