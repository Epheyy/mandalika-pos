import type { components } from '@mandalika/api'
import type { ReceiptData } from '@mandalika/printer'
import { buildReceiptQuote, receiptFromQuote, type QuoteDerived, type QuoteLineInput } from './receiptQuote'

type ReceiptSettings = components['schemas']['ReceiptSettings']

export type TotalRowKind = 'subtotal' | 'promo' | 'surcharge' | 'points' | 'tax' | 'rounding' | 'total'

/** One row of the totals block. `amount` is signed: deductions are negative. */
export interface TotalRow {
  key: string
  kind: TotalRowKind
  label: string
  amount: number
}

type TotalsInput = Pick<ReceiptData, 'subtotal' | 'discountAmount' | 'discounts' | 'surcharge' | 'pointsRedeemed' | 'rounding' | 'taxAmount' | 'total'>

/**
 * C1 follow-up: the totals rows as the printed receipt shows them (same order, same visibility rules as
 * `buildReceipt` in packages/printer): Subtotal, one row per promo / code / manual discount, Biaya tambahan,
 * Tukar poin, PPN, Pembulatan when non-zero, TOTAL. A pre-C1 receipt (no `discounts`) falls back to one "Diskon" row.
 */
export function receiptTotalRows(data: TotalsInput, settings: Pick<ReceiptSettings, 'showSubtotal' | 'showDiscount' | 'showTax'>): TotalRow[] {
  const rows: TotalRow[] = []
  // As the printer: an itemised (C1) slip always shows its deductions and PPN, since hiding a row that is
  // inside TOTAL would make it not add up. The Pengaturan toggles only govern pre-C1 receipts.
  const itemised = data.discounts !== undefined
  if (settings.showSubtotal !== false) rows.push({ key: 'subtotal', kind: 'subtotal', label: 'Subtotal', amount: data.subtotal })
  if (itemised || settings.showDiscount !== false) {
    if (data.discounts) {
      data.discounts.forEach((d, i) => {
        if (d.amount > 0) rows.push({ key: `promo-${i}`, kind: 'promo', label: d.label, amount: -d.amount })
      })
    } else if (data.discountAmount > 0) {
      rows.push({ key: 'promo-0', kind: 'promo', label: 'Diskon', amount: -data.discountAmount })
    }
  }
  if (data.surcharge && data.surcharge > 0) rows.push({ key: 'surcharge', kind: 'surcharge', label: 'Biaya tambahan', amount: data.surcharge })
  if (data.pointsRedeemed && data.pointsRedeemed.amount > 0) {
    rows.push({ key: 'points', kind: 'points', label: `Tukar poin (${data.pointsRedeemed.points})`, amount: -data.pointsRedeemed.amount })
  }
  if ((itemised || settings.showTax) && data.taxAmount > 0) rows.push({ key: 'tax', kind: 'tax', label: 'PPN', amount: data.taxAmount })
  if (data.rounding) rows.push({ key: 'rounding', kind: 'rounding', label: 'Pembulatan', amount: data.rounding })
  rows.push({ key: 'total', kind: 'total', label: 'TOTAL', amount: data.total })
  return rows
}

/** One payment row under TOTAL. `reference` renders as a second "Ref ..." line, as on the slip. */
export interface TenderRow {
  key: string
  label: string
  amount: number
  reference?: string
}

/**
 * C6: the payment rows as the printed receipt shows them (printer `buildReceipt`): one row per tender line
 * (amount = captured), else the single `paymentLabel` row with `amountPaid`.
 */
export function receiptTenderRows(data: Pick<ReceiptData, 'tenders' | 'paymentLabel' | 'amountPaid'>): TenderRow[] {
  if (data.tenders && data.tenders.length > 0) {
    return data.tenders.map((t, i) => ({ key: `tender-${i}`, label: t.label, amount: t.amount, ...(t.reference ? { reference: t.reference } : {}) }))
  }
  return [{ key: 'tender-0', label: data.paymentLabel, amount: data.amountPaid }]
}

/** The rows for the sale on screen, built through the same quote the printer uses (`receiptFromQuote`),
 *  so screen and paper take their numbers from one place. */
export function quoteTotalRows(
  cart: readonly QuoteLineInput[],
  derived: QuoteDerived,
  settings: Pick<ReceiptSettings, 'showSubtotal' | 'showDiscount' | 'showTax'>,
): TotalRow[] {
  const quote = buildReceiptQuote({ cart, derived, tender: { amountPaid: 0, change: 0 }, refVersion: 0 })
  const data = receiptFromQuote(quote, {
    orderRef: '', dateTime: new Date(0), paymentLabel: '', customerName: null, customerPhone: null, cashierName: '',
  })
  return receiptTotalRows(data, settings)
}

/** The slice of a stored order the adjustment needs. */
type StoredOrderTotals = {
  subtotal: number; discountAmount: number; surchargeAmount?: number | null; taxAmount: number; total: number
  pointsRedeemed?: number | null; pointsRedemptionAmount?: number | null
}

/**
 * F24: legacy fallback for a stored order (Riwayat) from a server that does not report `pointsRedemptionAmount`.
 * Loyalty redemption and rounding both sit inside `total`; the residual of subtotal - discount + surcharge + PPN -
 * total is exactly their sum, so the screen shows it as one signed row and the block adds up. Null when the lines
 * already sum (|residual| < Rp 1). Newer orders go through `orderAdjustmentRows`, which splits the two.
 */
export function orderAdjustmentRow(o: StoredOrderTotals): TotalRow | null {
  const residual = o.subtotal - o.discountAmount + (o.surchargeAmount ?? 0) + o.taxAmount - o.total
  if (Math.abs(residual) < 1) return null
  const amount = -Math.round(residual)
  return { key: 'adjustment', kind: amount < 0 ? 'points' : 'rounding', label: 'Tukar poin / pembulatan', amount }
}

/**
 * Riwayat rows for what sits between the visible lines and `total`. When the server reports the points
 * redemption (`pointsRedemptionAmount`) it gets its own "Tukar poin (N)" row, same wording as the receipt, and only
 * what is still unexplained shows as "Pembulatan". An order from an older server (no field) keeps the single
 * residual row from `orderAdjustmentRow`.
 */
export function orderAdjustmentRows(o: StoredOrderTotals): TotalRow[] {
  const redeemed = o.pointsRedemptionAmount ?? 0
  if (redeemed <= 0) {
    const legacy = orderAdjustmentRow(o)
    return legacy ? [legacy] : []
  }
  const rows: TotalRow[] = []
  const points = o.pointsRedeemed ?? 0
  rows.push({ key: 'points', kind: 'points', label: points > 0 ? `Tukar poin (${points})` : 'Tukar poin', amount: -Math.round(redeemed) })
  const residual = o.subtotal - o.discountAmount + (o.surchargeAmount ?? 0) + o.taxAmount - redeemed - o.total
  if (Math.abs(residual) >= 1) {
    rows.push({ key: 'rounding', kind: 'rounding', label: 'Pembulatan', amount: -Math.round(residual) })
  }
  return rows
}
