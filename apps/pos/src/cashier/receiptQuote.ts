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

/** One named deduction on the slip (C1). Same shape the printer takes. */
export interface SnapshotDiscount {
  label: string
  amount: number
}

/** C6: one payment line on the slip; `amount` is what was captured (cash handed over / amount charged). */
export interface SnapshotTender {
  method: string
  label: string
  amount: number
  reference?: string
}

/** v1 = pre-C1 (single discount total, no itemisation); v2 = C1 (itemised, adds up line by line). */
export interface ReceiptSnapshot {
  v: 1 | 2
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
  /** v2: one row per promo / code / manual discount; sums to discountAmount. */
  discounts?: SnapshotDiscount[]
  /** v2: points spent on this sale (redeemAmount is their Rupiah value). */
  redeemedPoints?: number
  /** v2: signed rounding delta between the pre-rounding total and `total`. */
  roundingAmount?: number
  /** C6: one row per payment line of a split sale; absent on a plain one-method sale and on older archives. */
  tenders?: SnapshotTender[]
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
  /** C1: itemised deductions; when absent a single "Diskon" row is derived from discountAmount. */
  discountParts?: SnapshotDiscount[]
  redeemedPoints?: number
  roundingAmount?: number
}

export function buildReceiptQuote(input: {
  cart: readonly QuoteLineInput[]
  derived: QuoteDerived
  tender: { amountPaid: number; change: number }
  refVersion: number
  tenders?: SnapshotTender[]
}): ReceiptQuote {
  const { cart, derived, tender, refVersion, tenders } = input
  return {
    quotedTotal: derived.total,
    receiptSnapshot: {
      v: 2,
      refVersion,
      subtotal: derived.subtotal,
      discountAmount: derived.discountAmount,
      surchargeAmount: derived.surchargeAmount,
      taxAmount: derived.taxAmount,
      redeemAmount: derived.redeemAmount,
      total: derived.total,
      amountPaid: tender.amountPaid,
      change: tender.change,
      discounts: derived.discountParts ?? (derived.discountAmount > 0 ? [{ label: 'Diskon', amount: derived.discountAmount }] : []),
      redeemedPoints: derived.redeemedPoints ?? 0,
      roundingAmount: derived.roundingAmount ?? 0,
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
      ...(tenders && tenders.length > 0 ? { tenders } : {}),
    },
  }
}

/**
 * C1: does the slip add up? subtotal - discounts + biaya tambahan - tukar poin + PPN + pembulatan = total,
 * and the line amounts add to the subtotal. A pre-C1 receipt (no `discounts`) has no itemisation to check
 * and is reported as adding up only when its legacy totals do.
 */
export function receiptAddsUp(data: ReceiptData): boolean {
  const lineSum = data.lines.reduce((sum, l) => sum + l.amount, 0)
  if (lineSum !== data.subtotal) return false
  const discount = data.discounts ? data.discounts.reduce((sum, d) => sum + d.amount, 0) : data.discountAmount
  const expected =
    data.subtotal - discount + (data.surcharge ?? 0) - (data.pointsRedeemed?.amount ?? 0) + data.taxAmount + (data.rounding ?? 0)
  return expected === data.total
}

/** The printed receipt: money and lines come ONLY from the quote. */
export function receiptFromQuote(
  quote: ReceiptQuote,
  extras: Pick<ReceiptData, 'orderRef' | 'dateTime' | 'paymentLabel' | 'customerName' | 'customerPhone' | 'cashierName'>,
): ReceiptData {
  const s = quote.receiptSnapshot
  const itemised = s.v >= 2
  const data: ReceiptData = {
    ...extras,
    pending: false, // client-authoritative number; matches history
    lines: s.lines.map((l) => ({
      name: l.name,
      variant: variantLabel(l.variantSize) || undefined,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: l.amount,
      ...(itemised ? { isReward: l.isReward === true } : {}),
    })),
    subtotal: s.subtotal,
    discountAmount: s.discountAmount,
    // v1 archives lack these: leave them undefined so the printer falls back to its legacy rows.
    ...(itemised
      ? {
          discounts: s.discounts ?? [],
          surcharge: s.surchargeAmount > 0 ? s.surchargeAmount : null,
          pointsRedeemed: s.redeemAmount > 0 ? { points: s.redeemedPoints ?? 0, amount: s.redeemAmount } : null,
          rounding: s.roundingAmount ? s.roundingAmount : null,
        }
      : {}),
    taxAmount: s.taxAmount,
    total: quote.quotedTotal,
    amountPaid: s.amountPaid,
    change: s.change,
    ...(s.tenders && s.tenders.length > 0
      ? { tenders: s.tenders.map((t) => ({ label: t.label, amount: t.amount, ...(t.reference ? { reference: t.reference } : {}) })) }
      : {}),
  }
  if (import.meta.env.DEV && itemised && !receiptAddsUp(data)) {
    console.warn('[receipt] slip does not add up', data.orderRef, data)
  }
  return data
}
