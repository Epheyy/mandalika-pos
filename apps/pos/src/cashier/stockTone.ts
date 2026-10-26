export type StockTone = 'ok' | 'warn' | 'danger'

/** D-20: at or below this many units (but above zero) a tile shows the amber state. */
export const LOW_STOCK_THRESHOLD = 2

/** green from 3 up, amber for 1-2, red at 0 or below. */
export function stockTone(stock: number): StockTone {
  if (stock <= 0) return 'danger'
  if (stock <= LOW_STOCK_THRESHOLD) return 'warn'
  return 'ok'
}

/** "Stok 9", "Habis" at exactly 0, "Stok −3" below zero. */
export function stockLabel(stock: number): string {
  if (stock === 0) return 'Habis'
  if (stock < 0) return `Stok −${Math.abs(stock)}`
  return `Stok ${stock}`
}

// Static lookups so Tailwind can see every class as a whole string.
export const STOCK_TEXT_CLASS: Record<StockTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
}
export const STOCK_DOT_CLASS: Record<StockTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
}
