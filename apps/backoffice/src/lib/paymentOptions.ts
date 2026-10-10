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
  for (const m of methods ?? []) add(m.id, m.label)
  add('cash', 'Tunai')
  for (const o of orders) add(o.paymentMethod, o.paymentMethod)
  return out
}
