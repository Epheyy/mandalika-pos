import type { Order, OrderRefund } from '@mandalika/api'
import { isCashMethod } from '@mandalika/types'

/** The reserved orders.payment_method sentinel of a split-payment sale (never a real method id). */
export const SPLIT_METHOD_ID = 'split'
/** Owner label (D-60). */
export const SPLIT_LABEL = 'Split-Payment'

type MethodConfig = { id: string; label: string; isCash?: boolean | null; isEnabled?: boolean }
type Methods = ReadonlyArray<MethodConfig> | null | undefined
type TenderLine = NonNullable<Order['tenders']>[number]

const norm = (s: string) => s.trim().toLowerCase()
const amountText = (n: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(n)

/** Display label of a method id: the sentinel, then the configured label, else the raw id. */
export function methodLabel(methodId: string, methods?: Methods): string {
  const key = norm(methodId)
  if (key === SPLIT_METHOD_ID) return SPLIT_LABEL
  const hit = (methods ?? []).find((m) => norm(m.id) === key)
  return hit?.label?.trim() || methodId
}

/** True for the split sentinel (case-insensitive), as the server's isSplitID. */
export const isSplitMethodId = (methodId: string) => norm(methodId) === SPLIT_METHOD_ID

/** Same split test as the server (service/refund_payout.go isSplitOrder): the sentinel, or tender lines
 *  naming more than one distinct method. An order without lines (an older server) is single-method. */
export function isSplitOrder(o: Pick<Order, 'paymentMethod' | 'tenders'>): boolean {
  if (isSplitMethodId(o.paymentMethod)) return true
  return new Set((o.tenders ?? []).map((t) => norm(t.method))).size > 1
}

const orderedLines = (o: Pick<Order, 'tenders'>): TenderLine[] =>
  [...(o.tenders ?? [])].sort((a, b) => a.seq - b.seq)

/** One tender line as "QRIS 751.000" (the CSV form: plain amount, no currency sign). */
export function tenderLineText(t: Pick<TenderLine, 'method' | 'amount'>, methods?: Methods): string {
  return `${methodLabel(t.method, methods)} ${amountText(t.amount)}`
}

/** CSV "Pembayaran": "QRIS 751.000; Tunai 500.000" for a split order, the unchanged raw method id otherwise. */
export function orderPaymentCsv(o: Pick<Order, 'paymentMethod' | 'tenders'>, methods?: Methods): string {
  const lines = orderedLines(o)
  if (!isSplitOrder(o) || lines.length === 0) return o.paymentMethod
  return lines.map((t) => tenderLineText(t, methods)).join('; ')
}

/** List/detail text for the method of an order: the label for a split order, the raw id otherwise. */
export function orderMethodText(o: Pick<Order, 'paymentMethod'>): string {
  return isSplitMethodId(o.paymentMethod) ? SPLIT_LABEL : o.paymentMethod
}

/** Titles of the "⚠ Bayar" badge by tenderWarningReason. */
const TENDER_WARNING_TITLES: Record<string, string> = {
  cash_short: 'Tunai kurang dari total',
  noncash_amount_mismatch: 'Nominal non-tunai beda dari total',
  tender_short: 'Uang yang diterima kurang dari total',
  noncash_overpay: 'Pembayaran non-tunai melebihi total',
  tender_cash_merged: 'Beberapa baris tunai digabung jadi satu',
}

export function tenderWarningTitle(reason?: string | null): string | undefined {
  return reason ? (TENDER_WARNING_TITLES[reason] ?? reason) : undefined
}

/** Detail rows of the payment lines: method label, applied amount, the reference and the change. */
export interface PaymentLineRow {
  key: string
  label: string
  amount: number
  tendered: number
  change: number
  reference: string
  /** A line synthesised by the server for an order stored before split payment (no real capture). */
  synthetic: boolean
}

export function paymentLineRows(o: Pick<Order, 'tenders'>, methods?: Methods): PaymentLineRow[] {
  return orderedLines(o).map((t) => ({
    key: `${t.seq}|${t.method}`,
    label: methodLabel(t.method, methods),
    amount: t.amount,
    tendered: t.tendered,
    change: t.change,
    reference: (t.reference ?? '').trim(),
    synthetic: t.synthetic,
  }))
}

const SOURCE_TEXT: Record<string, string> = {
  sale: 'sama dengan metode penjualan',
  chosen: 'dipilih saat refund',
  default: 'otomatis: tunai, atau pembayaran terbesar',
}

/** Plain-Indonesian payout of one refund: "Dikembalikan lewat Tunai (dipilih saat refund)".
 *  A refund written before C6a has no source and shows the method alone. */
export function refundPayoutText(r: Pick<OrderRefund, 'paymentMethod' | 'payoutSource'>, methods?: Methods): string {
  const method = (r.paymentMethod ?? '').trim()
  if (!method) return ''
  const src = r.payoutSource ? SOURCE_TEXT[r.payoutSource] : undefined
  return `Dikembalikan lewat ${methodLabel(method, methods)}${src ? ` (${src})` : ''}`
}

/** Distinct payout methods of an order's refunds as labels, for the orders CSV ("" without refunds). */
export function refundPayoutCsv(o: Pick<Order, 'refunds'>, methods?: Methods): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of o.refunds ?? []) {
    const m = (r.paymentMethod ?? '').trim()
    if (!m || seen.has(norm(m))) continue
    seen.add(norm(m))
    out.push(methodLabel(m, methods))
  }
  return out.join('; ')
}

/** D-56 default payout of a split order: the cash line's method (lowest seq) when the sale had cash,
 *  else the line with the largest applied amount (ties: lowest seq). Must agree with the server's
 *  defaultPayoutMethod and the SQL order_default_payout_method. Returns '' for no lines. */
export function defaultPayoutMethod(o: Pick<Order, 'tenders'>, methods?: Methods): string {
  const lines = orderedLines(o)
  const cash = lines.find((t) => isCashMethod(methods ?? [], t.method))
  if (cash) return cash.method
  let best: TenderLine | undefined
  for (const t of lines) if (!best || t.amount > best.amount) best = t
  return best?.method ?? ''
}

export interface PayoutChoices {
  /** Method ids offered, sale methods first (in line order), then cash when the sale had none. */
  options: Array<{ id: string; label: string }>
  /** Preselected id (the D-56 default); '' when nothing to offer. */
  defaultId: string
}

/** Payout chips for the admin refund form of a split order: the sale's methods plus cash (D-57). */
export function payoutChoices(o: Pick<Order, 'tenders'>, methods?: Methods): PayoutChoices {
  const options: Array<{ id: string; label: string }> = []
  const seen = new Set<string>()
  const add = (id: string) => {
    const key = norm(id)
    if (!key || seen.has(key)) return
    seen.add(key)
    options.push({ id, label: methodLabel(id, methods) })
  }
  for (const t of orderedLines(o)) add(t.method)
  if (!options.some((c) => isCashMethod(methods ?? [], c.id))) {
    const cash = (methods ?? []).find((m) => m.isEnabled !== false && isCashMethod(methods ?? [], m.id))
    if (cash) add(cash.id)
  }
  return { options, defaultId: defaultPayoutMethod(o, methods) }
}
