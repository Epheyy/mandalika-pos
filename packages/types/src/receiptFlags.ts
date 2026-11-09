/**
 * One reading of the eight `receipt.show*` flags, shared by the printer, the on-screen receipt and the
 * Backoffice switches so the three can never disagree (QA R11 F35).
 *
 * The stored object can be partial (the server keeps what was last sent) and some keys are nullable, so a
 * missing flag needs a default. These defaults are exactly what the ESC/POS printer has always done, so
 * resolving a flag never changes what a tablet already prints:
 *   absent/null = ON  (the printer tests `!== false`): order number, subtotal, discount, change, customer name
 *   absent/null = OFF (the printer tests truthiness):  tax, cashier, customer phone
 */
export const RECEIPT_FLAG_KEYS = [
  'showOrderNumber',
  'showCashier',
  'showCustomerName',
  'showCustomerPhone',
  'showTax',
  'showDiscount',
  'showSubtotal',
  'showChange',
] as const

export type ReceiptFlagKey = (typeof RECEIPT_FLAG_KEYS)[number]
export type ReceiptFlags = Record<ReceiptFlagKey, boolean>

/** What an absent or null flag means, per key. */
export const RECEIPT_FLAG_DEFAULTS: Readonly<ReceiptFlags> = {
  showOrderNumber: true,
  showCashier: false,
  showCustomerName: true,
  showCustomerPhone: false,
  showTax: false,
  showDiscount: true,
  showSubtotal: true,
  showChange: true,
}

type FlagInput = { [K in ReceiptFlagKey]?: boolean | null }

/** All eight flags as plain booleans. An explicit true/false always wins; absent or null takes the default. */
export function resolveReceiptFlags(receipt?: FlagInput | null): ReceiptFlags {
  const out = { ...RECEIPT_FLAG_DEFAULTS }
  if (!receipt) return out
  for (const k of RECEIPT_FLAG_KEYS) {
    const v = receipt[k]
    if (typeof v === 'boolean') out[k] = v
  }
  return out
}
