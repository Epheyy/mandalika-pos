// Canonical ingredient units of measure. Choose one of these in the form,
// or pick "Lainnya" to reveal a free-text input.
export const COMMON_UNITS = ['g', 'kg', 'mg', 'ml', 'L', 'drop', 'pcs'] as const
export type CommonUnit = (typeof COMMON_UNITS)[number]

export function isCommonUnit(u: string): u is CommonUnit {
  return (COMMON_UNITS as readonly string[]).includes(u)
}
