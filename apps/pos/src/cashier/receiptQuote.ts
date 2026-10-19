import type { ReceiptData } from '@mandalika/printer'
import { variantLabel } from '@mandalika/types'

// A10: the money and lines the cashier showed. Built ONCE inside the sale gate and
// used twice: embedded in the order payload (quotedTotal + receiptSnapshot) and
// turned into the printed receipt, so printed == quoted by construction. The server
// only stores it and flags a difference; it never trusts it for money. No customer
// name or phone goes in here (A30).

export interface QuoteLineInput {
  productId: string
  productName: string
  variantSize: string
  price: number
  quantity: number
  subtotal: number
  isBundle?: boolean
  isReward?: boolean
}

export interface ReceiptSnapshotLine {
  productId: string
  variantSize: string
  name: string
  qty: number
  unitPrice: number
  amount: number
  isReward?: boolean
  isBundle?: boolean
}

export interface ReceiptSnapshot {
  v: 1
  /** Reference-data version (snapshot localVersion()) the sale was priced against. */
  refVersion: number
  subtotal: number
  discountAmount: number
  surchargeAmount: number
  taxAmount: number
  redeemAmount: number
  total: number
  amountPaid: number
  change: number
  lines: ReceiptSnapshotLine[]
}

export interface ReceiptQuote {
  quotedTotal: number
  receiptSnapshot: ReceiptSnapshot
}

export interface QuoteDerived {
  subtotal: number
  discountAmount: number
  surchargeAmount: number
  taxAmount: number
  redeemAmount: number
  total: number
}

export function buildReceiptQuote(input: {
  cart: readonly QuoteLineInput[]
  derived: QuoteDerived
  tender: { amountPaid: number; change: number }
  refVersion: number
}): ReceiptQuote {
  const { cart, derived, tender, refVersion } = input
  return {
    quotedTotal: derived.total,
    receiptSnapshot: {
      v: 1,
      refVersion,
      subtotal: derived.subtotal,
      discountAmount: derived.discountAmount,
      surchargeAmount: derived.surchargeAmount,
      taxAmount: derived.taxAmount,
      redeemAmount: derived.redeemAmount,
      total: derived.total,
      amountPaid: tender.amountPaid,
      change: tender.change,
      lines: cart.map((c) => ({
        productId: c.productId,
        variantSize: c.variantSize,
        name: c.productName,
        qty: c.quantity,
        unitPrice: c.price,
        amount: c.subtotal,
        ...(c.isReward ? { isReward: true as const } : {}),
        ...(c.isBundle ? { isBundle: true as const } : {}),
      })),
    },
  }
}

/** The printed receipt: money and lines come ONLY from the quote. */
export function receiptFromQuote(
  quote: ReceiptQuote,
  extras: Pick<ReceiptData, 'orderRef' | 'dateTime' | 'paymentLabel' | 'customerName' | 'customerPhone' | 'cashierName'>,
): ReceiptData {
  const s = quote.receiptSnapshot
  return {
    ...extras,
    pending: false, // client-authoritative number; matches history
    lines: s.lines.map((l) => ({
      name: l.name,
      variant: variantLabel(l.variantSize) || undefined,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: l.amount,
    })),
    subtotal: s.subtotal,
    discountAmount: s.discountAmount,
    taxAmount: s.taxAmount,
    total: quote.quotedTotal,
    amountPaid: s.amountPaid,
    change: s.change,
  }
}
