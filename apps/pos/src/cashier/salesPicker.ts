export interface SalesPick { id: string; name: string }

interface SalesPickSnapshot {
  salesStaff?: readonly SalesPick[]
  users?: readonly { id: string; displayName?: string }[]
}

/** Shown for a saved pick whose name is blank and who is not listed; display only, the id is still sent. */
export const UNKNOWN_SALES_LABEL = '(sales tidak dikenal)'

function listed(snapshot: SalesPickSnapshot): SalesPick[] {
  return snapshot.salesStaff
    ? snapshot.salesStaff.map((s) => ({ id: s.id, name: s.name }))
    : (snapshot.users ?? []).map((u) => ({ id: u.id, name: u.displayName ?? '' })).filter((s) => s.name !== '')
}

/** The checkout "Sales" options: the outlet's sales staff list (even when empty); an old server that sends
 *  none falls back to named users. A saved pick that is no longer listed (switched off, or an id from before
 *  this list existed) stays credited, so it is appended and the cashier still sees who it is. Server order. */
export function salesPickList(snapshot: SalesPickSnapshot, selected: SalesPick | null): SalesPick[] {
  const list = listed(snapshot)
  if (selected && !list.some((s) => s.id === selected.id)) {
    list.push({ id: selected.id, name: selected.name.trim() === '' ? UNKNOWN_SALES_LABEL : selected.name })
  }
  return list
}

/** The salesperson a sale records: a pick still listed carries the list's current name (what the cashier
 *  sees is what is recorded); an unlisted pick keeps its saved id and name. */
export function resolveSelectedSalesman(snapshot: SalesPickSnapshot, selected: SalesPick | null): SalesPick | null {
  if (!selected) return null
  return listed(snapshot).find((s) => s.id === selected.id) ?? selected
}
