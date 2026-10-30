/** Label for a sale paid with several methods (C6); the sentinel payment value is `split`. */
export const SPLIT_LABEL = 'Split-Payment'

/** Display names for payment method codes; one source for cashier, receipts and refunds. */
export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS', split: SPLIT_LABEL,
}

/** Label for a payment code, falling back to the raw code for unknown methods. */
export function paymentLabel(code: string): string {
  return PAYMENT_LABELS[code] ?? code
}

/** Label for one tender line: built-in name, else the configured method's label, else the raw id. */
export function tenderLabel(id: string, methods?: readonly { id: string; label: string }[]): string {
  const builtin = PAYMENT_LABELS[id]
  if (builtin) return builtin
  const lower = id.toLowerCase()
  return methods?.find((m) => m.id.toLowerCase() === lower)?.label ?? id
}
