import { SPLIT_LABEL, SPLIT_METHOD_ID, isSplitMethodId } from './splitPayment'

export interface PaymentOption {
  id: string
  label: string
}

/**
 * Options for a payment-method filter: every configured method (disabled ones too,
 * their historical orders still exist), the legacy "cash" id, then any other method
 * id found on the orders themselves. Ids are de-duplicated case-insensitively.
 */
export function paymentFilterOptions(
  methods: ReadonlyArray<{ id: string; label: string }> | null | undefined,
  orders: ReadonlyArray<{ paymentMethod: string }> = [],
): PaymentOption[] {
  const out: PaymentOption[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string) => {
    const key = id.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ id, label })
  }
  // The split sentinel is not a method: orders paid with several methods are found by each
  // method's own line, and the "Split-Payment" option below lists the split orders themselves.
  for (const m of methods ?? []) if (!isSplitMethodId(m.id)) add(m.id, m.label)
  add('cash', 'Tunai')
  for (const o of orders) if (!isSplitMethodId(o.paymentMethod)) add(o.paymentMethod, o.paymentMethod)
  add(SPLIT_METHOD_ID, SPLIT_LABEL)
  return out
}
