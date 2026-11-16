// Receipt data shapes (moved verbatim from escpos.ts; escpos.ts re-exports them).

/** One printable line of a receipt (already priced, server- or client-side). */
export interface ReceiptLine {
  name: string
  /** Variant/size — printed on its own indented line so it never clips. */
  variant?: string
  qty: number
  /** Per-unit price in whole Rupiah. */
  unitPrice: number
  /** Line total in whole Rupiah. */
  amount: number
  /** C1: a promo/loyalty giveaway line. Absent on receipts archived before C1. */
  isReward?: boolean
  /** C1: optional tag naming the reward (e.g. the promo); printed after the name. */
  rewardLabel?: string
  /** Bundles: the pieces of a bundle, printed under the name (one bullet each). `variant` is not used then. */
  pieces?: string[]
  /** Bundles: the Diskon Bundle printed under the line. `amount` stays the NET, so the slip still adds up; the amount
   *  column of the qty row shows `amount + lineDiscount.amount` (the bundle price). */
  lineDiscount?: ReceiptDiscountRow
}

/** C1: one deduction row (a promo, a code or the manual discount), already in whole Rupiah. */
export interface ReceiptDiscountRow {
  label: string
  amount: number
}

/** Everything needed to render a slip, online or offline-queued. */
export interface ReceiptData {
  /** Server order number when known; provisional uuid prefix when offline. */
  orderRef: string
  pending: boolean
  dateTime: Date
  lines: ReceiptLine[]
  subtotal: number
  /** Total deduction. Kept for old callers; the printer prefers `discounts` when present. */
  discountAmount: number
  /** C1: one row per applied promo / code / manual discount. Absent on pre-C1 archived receipts
   *  (the printer then falls back to a single "Diskon" row from `discountAmount`). */
  discounts?: ReceiptDiscountRow[]
  /** C1: "Biaya tambahan", already inside `total`. null/absent = none. */
  surcharge?: number | null
  /** C1: "Tukar poin" redemption, already deducted from `total`. null/absent = none. */
  pointsRedeemed?: { points: number; amount: number } | null
  /** C1: cash/total rounding delta (signed) so the slip still adds up when rounding is on. */
  rounding?: number | null
  taxAmount: number
  total: number
  paymentLabel: string
  amountPaid: number
  /** C6: one row per payment line of a split sale (amount = captured). Absent = print the single `paymentLabel` row. */
  tenders?: { label: string; amount: number; reference?: string }[]
  change: number
  customerName: string | null
  customerPhone: string | null
  cashierName: string
  /** Void: the number of the sale this one replaces; prints "Pengganti untuk #<ref>" under the header. */
  replacesOrderRef?: string
  /** Void: signed "Penyesuaian koreksi" already inside `total` (non-zero prints a row before TOTAL). */
  correctionAmount?: number
}
