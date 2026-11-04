/** Stock-matrix helpers: totals of the columns on screen, and quantity text for fractional units. */

interface QtyCell {
  locationId: string
}

/** Sum of the cells whose location is shown; the server `total` also counts every hidden location. */
export function visibleTotal<C extends QtyCell>(cells: readonly C[], locationIds: readonly string[], qtyOf: (c: C) => number): number {
  const shown = new Set(locationIds)
  let sum = 0
  for (const c of cells) if (shown.has(c.locationId)) sum += qtyOf(c)
  return sum
}

const qtyFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 })

/** "295,5 g": id-ID comma decimals, trailing zeros trimmed, optional unit. */
export function formatQty(n: number, unit?: string | null): string {
  const text = qtyFormat.format(Math.abs(n) < 0.0005 ? 0 : n)
  return unit?.trim() ? `${text} ${unit.trim()}` : text
}
