export type ParInput = { ok: true; value: number | null } | { ok: false }

/** What a PAR box holds, as a stored value: empty clears it (null), otherwise a whole number from 0 up. */
export function parseParInput(raw: string): ParInput {
  const text = raw.trim()
  if (text === '') return { ok: true, value: null }
  const n = Number(text)
  if (!Number.isInteger(n) || n < 0) return { ok: false }
  return { ok: true, value: n }
}

/** A blur that left the PAR as it was must not write: a stock-setting write with nothing to say is noise. */
export function parChanged(next: number | null, current: number | null | undefined): boolean {
  return next !== (current ?? null)
}
