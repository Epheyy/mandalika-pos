export interface SalesPick { id: string; name: string }

interface SalesPickSnapshot {
  salesStaff?: readonly SalesPick[]
  users?: readonly { id: string; displayName?: string }[]
}

/** The checkout "Sales" options: the outlet's sales staff list (even when empty); an old server that sends
 *  none falls back to named users. A saved pick that is no longer listed (switched off, or an id from before
 *  this list existed) stays credited, so it is appended and the cashier still sees who it is. Server order. */
export function salesPickList(snapshot: SalesPickSnapshot, selected: SalesPick | null): SalesPick[] {
  const list: SalesPick[] = snapshot.salesStaff
    ? snapshot.salesStaff.map((s) => ({ id: s.id, name: s.name }))
    : (snapshot.users ?? []).map((u) => ({ id: u.id, name: u.displayName ?? '' })).filter((s) => s.name !== '')
  if (selected && !list.some((s) => s.id === selected.id)) list.push({ id: selected.id, name: selected.name })
  return list
}
