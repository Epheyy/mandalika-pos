/** Display names for payment method codes; one source for cashier, receipts and refunds. */
export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS',
}

/** Label for a payment code, falling back to the raw code for unknown methods. */
export function paymentLabel(code: string): string {
  return PAYMENT_LABELS[code] ?? code
}
