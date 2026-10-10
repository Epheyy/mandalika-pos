/** Minimal shape of a configured payment method (see AppSettings.paymentMethods). */
export interface CashFlagMethod {
  id: string
  /** Money goes into the cash drawer. Absent/null = default by id (cash, tunai). */
  isCash?: boolean | null
}

/**
 * Whether a payment method id puts money in the cash drawer. Mirrors the backend
 * IsCashMethod: an entry (case-insensitive id) with an explicit boolean decides,
 * including an explicit false; otherwise the id default applies ("cash"/"tunai"),
 * which also covers ids that are not in the config.
 */
export function isCashMethod(methods: readonly CashFlagMethod[] | null | undefined, id: string): boolean {
  const key = id.trim().toLowerCase()
  const entry = (methods ?? []).find((m) => m.id.trim().toLowerCase() === key)
  if (typeof entry?.isCash === 'boolean') return entry.isCash
  return key === 'cash' || key === 'tunai'
}
