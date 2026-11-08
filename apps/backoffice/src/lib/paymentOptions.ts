import { isCashMethod } from '@mandalika/types'
import { SPLIT_LABEL, SPLIT_METHOD_ID, isSplitMethodId } from './splitPayment'

export interface PaymentOption {
  id: string
  label: string
}

export const LEGACY_CASH_ID = 'cash'
export const LEGACY_CASH_LABEL = 'Tunai (data lama)'

/** Readable label for a method id that is no longer configured: "MANDIRI (nonaktif)". The id itself is never changed. */
export function retiredMethodLabel(id: string): string {
  return `${id.trim().replace(/_/g, ' ').toUpperCase()} (nonaktif)`
}

/**
 * Options for a payment-method filter: every configured method (disabled ones too, their
 * historical orders still exist), the legacy "cash" id, then any other method id found on
 * the orders themselves or in `historicalIds` (method ids the server reports for the same
 * period, so a method removed from settings can still be filtered). Ids are de-duplicated
 * case-insensitively.
 *
 * The server filters by the exact id (case-insensitive), so "cash" (old orders) and a
 * configured "tunai" are different data sets and are never merged into one option. When a
 * configured cash method with another id exists, the legacy one is labelled "data lama"
 * so the two cannot be mistaken for each other. Stored ids are untouched.
 */
export function paymentFilterOptions(
  methods: ReadonlyArray<{ id: string; label: string; isCash?: boolean | null }> | null | undefined,
  orders: ReadonlyArray<{ paymentMethod: string }> = [],
  historicalIds: ReadonlyArray<string> = [],
): PaymentOption[] {
  const out: PaymentOption[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string) => {
    const key = id.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ id, label })
  }
  const configured = (methods ?? []).filter((m) => !isSplitMethodId(m.id))
  // The split sentinel is not a method: orders paid with several methods are found by each
  // method's own line, and the "Split-Payment" option below lists the split orders themselves.
  for (const m of configured) add(m.id, m.label)
  const hasOtherCash = configured.some((m) => m.id.trim().toLowerCase() !== LEGACY_CASH_ID && isCashMethod(methods, m.id))
  add(LEGACY_CASH_ID, hasOtherCash ? LEGACY_CASH_LABEL : 'Tunai')
  // Until the settings list has loaded we cannot tell a retired method from a live one, so keep the raw id.
  const unknownLabel = (id: string) => (methods ? retiredMethodLabel(id) : id)
  for (const o of orders) if (!isSplitMethodId(o.paymentMethod)) add(o.paymentMethod, unknownLabel(o.paymentMethod))
  for (const id of historicalIds) if (!isSplitMethodId(id)) add(id, unknownLabel(id))
  add(SPLIT_METHOD_ID, SPLIT_LABEL)
  return out
}
