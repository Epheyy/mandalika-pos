// D-4 blind count and D-5 denomination counter at Tutup Shift. Display rules only: nothing here changes what
// is closed, stored or printed.

/** Banknotes the denomination counter lists, largest first; coins are one free amount (D-5). */
export const DENOMINATIONS = [100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000] as const

export type DenominationCounts = Readonly<Record<number, number>>

const wholeCount = (n: number | undefined): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0)

/** Total counted cash: each note's count (whole, never negative) times its value, plus the coin amount. */
export function denominationTotal(counts: DenominationCounts, coins: number): number {
  const notes = DENOMINATIONS.reduce((sum, d) => sum + d * wholeCount(counts[d]), 0)
  return notes + wholeCount(coins)
}

/**
 * Whether the system's expected amounts may show. With the setting off they always do. With it on they stay hidden
 * until EVERY Terhitung field (every enabled method, 0 counts as entered) has a value, then all appear together.
 * Based on the fields, not on which methods took money, so hiding never hints at sales.
 */
export function isCountRevealed(blind: boolean, fieldIds: readonly string[], counted: Readonly<Record<string, number>>): boolean {
  if (!blind) return true
  return fieldIds.every((id) => counted[id] !== undefined)
}

/** Owner decision 2026-11-05: blind count at Tutup Shift is ON until a manager turns it off in Pengaturan. */
export const BLIND_COUNT_DEFAULT = true
