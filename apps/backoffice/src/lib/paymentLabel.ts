/** One canonical code + display label per payment method, whatever casing or alias the data carries. */

const ALIASES: Record<string, string> = { tunai: 'cash' }
const FIXED_LABELS: Record<string, string> = {
  cash: 'Tunai',
  card: 'Kartu',
  qris: 'QRIS',
  transfer: 'Transfer',
  bca: 'BCA',
  bri: 'BRI',
  bni: 'BNI',
  mandiri: 'Mandiri',
}

type NamedMethod = { id: string; label: string }

/** Lower-cased, trimmed id with aliases folded in ("Cash"/"Tunai" -> "cash"). */
export function canonicalMethodCode(id: string): string {
  const key = id.trim().toLowerCase()
  return ALIASES[key] ?? key
}

const titleCase = (s: string): string => s.replace(/[\w]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())

/** Fixed names for the built-ins, else the configured method's name, else a title-cased id. */
export function canonicalMethodLabel(id: string, methods?: ReadonlyArray<NamedMethod> | null): string {
  const code = canonicalMethodCode(id)
  if (code === 'cash') return FIXED_LABELS.cash
  // A configured name wins (a store may call bca "BCA Debit"); the fixed names are the fallback.
  const hit = (methods ?? []).find((m) => canonicalMethodCode(m.id) === code)
  return hit?.label?.trim() || FIXED_LABELS[code] || titleCase(code.replace(/[_-]+/g, ' '))
}

export interface PayRowLike {
  method: string
  label: string
  amount: number
}

/** Sums amounts by canonical code, so "Cash" and "cash" become one "Tunai" row. */
export function groupPayRows(pairs: Iterable<readonly [string, number]>, methods?: ReadonlyArray<NamedMethod> | null): PayRowLike[] {
  const sums = new Map<string, number>()
  for (const [id, amount] of pairs) {
    const code = canonicalMethodCode(id)
    sums.set(code, (sums.get(code) ?? 0) + amount)
  }
  return [...sums.entries()]
    .map(([method, amount]) => ({ method, label: canonicalMethodLabel(method, methods), amount }))
    .sort((a, b) => b.amount - a.amount || (a.method < b.method ? -1 : 1))
}
