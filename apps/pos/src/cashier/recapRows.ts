import { tenderLabel } from '../lib/paymentLabels'
import type { PaymentMethodCfg } from './recapAggregate'

export interface RecapRow { id: string; label: string; recorded: number; configured: boolean }

/** Rows of the shift reconciliation: every enabled method, plus any method (disabled or not configured at all)
 *  that holds a recorded amount, so the rows always add up to the Total Tercatat. */
export function recapRows(methods: readonly PaymentMethodCfg[], byMethod: Readonly<Record<string, number>>): RecapRow[] {
  const rows: RecapRow[] = []
  const seen = new Set<string>()
  for (const m of methods) {
    const recorded = byMethod[m.id] ?? 0
    seen.add(m.id)
    if (m.isEnabled || recorded !== 0) rows.push({ id: m.id, label: m.label, recorded, configured: true })
  }
  for (const [id, recorded] of Object.entries(byMethod)) {
    if (seen.has(id) || recorded === 0) continue
    rows.push({ id, label: tenderLabel(id, methods), recorded, configured: false })
  }
  return rows
}

/** Counted rows whose count differs from what was recorded (count − recorded). */
export function differenceLines(
  rows: readonly RecapRow[],
  counted: Readonly<Record<string, number>>,
): { id: string; label: string; diff: number }[] {
  return rows.flatMap((r) => {
    const c = counted[r.id]
    if (c === undefined) return []
    const diff = c - r.recorded
    return diff === 0 ? [] : [{ id: r.id, label: r.label, diff }]
  })
}
