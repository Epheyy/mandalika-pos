import type { CashFlagMethod } from '@mandalika/types'
import { isCashMethod } from '@mandalika/types'
import { cashTender } from './tender'

// C6 split tender, POS side. A TS twin of backend/internal/service/tender_split.go: the same allocation in whole
// cents with the Rp1 tolerance, checked against the shared golden vectors (tenderSplit.golden.test.ts). One line
// goes through the legacy single-tender rules unchanged (`tender.ts`); two or more are allocated.

/** D-51: at most four payment lines per sale. */
export const MAX_TENDER_LINES = 4
export const MAX_METHOD_LEN = 64
export const MAX_REFERENCE_LEN = 64
/** The reserved `orders.payment_method` sentinel for a sale paid with several methods (D-60 label "Split-Payment"). */
export const SPLIT_METHOD_ID = 'split'

const TOLERANCE_CENTS = 100 // Rp1: up to one rupiah is not a shortfall/mismatch
/** numeric(14,2) upper bound the server enforces per line and for the sum (service/order_input.go maxSaleMoney). */
const MAX_MONEY = 999_999_999_999.99

export type TenderMode = 'online' | 'batch'

/** One captured payment line. `amount` is what the line captured: the cash handed over, or the amount charged. */
export interface TenderLine {
  method: string
  amount: number
  reference?: string
}

/** One `order_tenders` row: `amount` is applied to the bill (rows sum to the due total), `tendered` is verbatim. */
export interface TenderRow {
  seq: number
  method: string
  amount: number
  tendered: number
  change: number
  reference?: string
}

export interface TenderSettlement {
  /** The shared method, or `split`. */
  paymentMethod: string
  /** Σ tendered. */
  amountPaid: number
  /** The cash line's change. */
  change: number
  /** "" when acceptable; else the server's tender_warning_reason. */
  reason: string
  lines: TenderRow[]
}

export type Allocation = { ok: true; settlement: TenderSettlement } | { ok: false; error: string }

const toCents = (v: number): number => Math.round(v * 100)
const fromCents = (c: number): number => c / 100

const REASON_ORDER = ['tender_short', 'cash_short', 'noncash_overpay', 'noncash_amount_mismatch', 'tender_cash_merged']
function reasonPriority(...reasons: string[]): string {
  for (const want of REASON_ORDER) if (reasons.includes(want)) return want
  return ''
}

/** Whether a method id is the reserved `split` sentinel (case- and edge-space-insensitive, as the server judges it). */
export const isSplitId = (m: string): boolean => m.trim().toLowerCase() === SPLIT_METHOD_ID

/** A control character (C0, DEL, C1) or a line/paragraph separator: not printable, refused like the server does. */
function hasNonPrintable(v: string): boolean {
  for (const ch of v) {
    const c = ch.codePointAt(0)!
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/** Single-line legacy judgement (service/tender.go evaluateTender) shaped as one row. */
function singleTender(line: TenderLine, due: number, isCash: boolean, mode: TenderMode): Allocation {
  const capC = toCents(line.amount)
  const dueC = toCents(due)
  let change = 0
  let reason = ''
  if (isCash) {
    if (capC >= dueC) change = fromCents(capC - dueC)
    else if (capC < dueC - TOLERANCE_CENTS) reason = 'cash_short'
  } else if (Math.abs(capC - dueC) > TOLERANCE_CENTS) reason = 'noncash_amount_mismatch'
  if (reason === 'cash_short' && mode === 'online') return { ok: false, error: 'Uang tunai yang diterima kurang dari total pembayaran' }
  return {
    ok: true,
    settlement: {
      paymentMethod: line.method,
      amountPaid: line.amount,
      change,
      reason,
      lines: [{ seq: 1, method: line.method, amount: due, tendered: line.amount, change, ...(line.reference ? { reference: line.reference } : {}) }],
    },
  }
}

interface Merged { lines: TenderLine[]; merged: boolean }

/** At most one cash line (D-52): online a second cash line is refused, in a batch the cash lines are merged. */
function mergeCashLines(lines: readonly TenderLine[], isCash: (m: string) => boolean, mode: TenderMode): Merged | string {
  const out: TenderLine[] = []
  let firstCash = -1
  let merged = false
  for (const l of lines) {
    if (!isCash(l.method)) { out.push(l); continue }
    if (firstCash < 0) { firstCash = out.length; out.push(l); continue }
    if (mode === 'online') return 'Hanya boleh satu pembayaran tunai per transaksi, gabungkan menjadi satu baris tunai'
    out[firstCash] = { ...out[firstCash]!, amount: fromCents(toCents(out[firstCash]!.amount) + toCents(l.amount)) }
    merged = true
  }
  return { lines: out, merged }
}

/** Allocation steps 1-3 (plan 2.3) in whole cents. */
function applyLines(dueC: number, lines: readonly TenderLine[], isCash: (m: string) => boolean): { rows: TenderRow[]; reason: string } {
  const amounts = lines.map(() => 0)
  const changes = lines.map(() => 0)
  let nonCash = 0
  let cashIdx = -1
  lines.forEach((l, i) => {
    if (isCash(l.method)) { cashIdx = i; return }
    amounts[i] = toCents(l.amount)
    nonCash += amounts[i]!
  })
  let reason = ''
  if (cashIdx >= 0) {
    const tendered = toCents(lines[cashIdx]!.amount)
    amounts[cashIdx] = Math.max(0, dueC - nonCash)
    changes[cashIdx] = Math.max(0, tendered - amounts[cashIdx]!)
    if (tendered < amounts[cashIdx]! - TOLERANCE_CENTS) reason = 'tender_short'
  }
  const sum = amounts.reduce((a, b) => a + b, 0)
  const diff = dueC - sum
  if (diff > 0) {
    amounts[amounts.length - 1]! += diff
    if (diff > TOLERANCE_CENTS) reason = 'tender_short'
  } else if (diff < 0) {
    let excess = -diff
    for (let i = amounts.length - 1; i >= 0 && excess > 0; i--) {
      const take = Math.min(amounts[i]!, excess)
      amounts[i]! -= take
      excess -= take
    }
    if (-diff > TOLERANCE_CENTS) reason = reasonPriority(reason, 'noncash_overpay')
  }
  const rows = lines.map((l, i): TenderRow => ({
    seq: i + 1,
    method: l.method,
    amount: fromCents(amounts[i]!),
    tendered: fromCents(toCents(l.amount)),
    change: fromCents(changes[i]!),
    ...(l.reference ? { reference: l.reference } : {}),
  }))
  return { rows, reason }
}

function summarize(rows: TenderRow[], reason: string): TenderSettlement {
  let paid = 0
  let change = 0
  let paymentMethod = rows[0]!.method
  for (const r of rows) {
    paid += toCents(r.tendered)
    change += toCents(r.change)
    if (r.method.trim().toLowerCase() !== rows[0]!.method.trim().toLowerCase()) paymentMethod = SPLIT_METHOD_ID
  }
  return { paymentMethod, amountPaid: fromCents(paid), change: fromCents(change), reason, lines: rows }
}

/**
 * Judge a sale's payment lines against the due total (after points). One line is the legacy path; two or more are
 * allocated. Mirrors service.settleTenders: `online` refuses any shortfall and a second cash line, `batch` accepts and flags.
 */
export function allocateTenders(due: number, lines: readonly TenderLine[], isCash: (method: string) => boolean, mode: TenderMode): Allocation {
  if (lines.length === 0) return { ok: false, error: 'Belum ada pembayaran' }
  if (lines.length === 1) return singleTender(lines[0]!, due, isCash(lines[0]!.method), mode)
  const m = mergeCashLines(lines, isCash, mode)
  if (typeof m === 'string') return { ok: false, error: m }
  if (m.lines.length === 1) { // batch: every line was cash and collapsed into one
    const s = singleTender(m.lines[0]!, due, isCash(m.lines[0]!.method), mode)
    if (s.ok) s.settlement.reason = reasonPriority(s.settlement.reason, m.merged ? 'tender_cash_merged' : '')
    return s
  }
  const { rows, reason } = applyLines(toCents(due), m.lines, isCash)
  if (reason === 'tender_short' && mode === 'online') {
    return { ok: false, error: 'Pembayaran yang diterima kurang dari total pembayaran' }
  }
  return { ok: true, settlement: summarize(rows, reasonPriority(reason, m.merged ? 'tender_cash_merged' : '')) }
}

/** Structural check of a tender list (the request-level rules of service.parseTenders). null = acceptable. */
export function tenderStructureError(lines: readonly TenderLine[]): string | null {
  if (lines.length < 1 || lines.length > MAX_TENDER_LINES) return `Pembayaran harus 1 sampai ${MAX_TENDER_LINES} baris`
  let sumC = 0
  for (const l of lines) {
    const method = l.method.trim()
    if (method === '') return 'Metode pembayaran wajib diisi'
    if ([...method].length > MAX_METHOD_LEN || hasNonPrintable(l.method)) return 'Metode pembayaran tidak valid'
    if (isSplitId(method)) return 'Metode pembayaran memakai id yang dicadangkan'
    if (!Number.isFinite(l.amount) || l.amount < 0 || l.amount > MAX_MONEY) return 'Jumlah pembayaran di luar rentang'
    if (lines.length > 1 && toCents(l.amount) === 0) return 'Jumlah pembayaran harus lebih dari nol'
    if (l.reference !== undefined && ([...l.reference].length > MAX_REFERENCE_LEN || hasNonPrintable(l.reference))) return 'No. referensi tidak valid'
    sumC += toCents(l.amount)
  }
  return fromCents(sumC) > MAX_MONEY ? 'Total pembayaran di luar rentang' : null
}

/** A cash predicate over the configured methods (isCash flag first, else the ids cash/tunai). */
export const cashPredicate = (methods: readonly CashFlagMethod[] | null | undefined) => (id: string): boolean => isCashMethod(methods, id)

/** Σ captured amounts of the lines. */
export const tenderedTotal = (lines: readonly TenderLine[]): number => fromCents(lines.reduce((s, l) => s + toCents(l.amount), 0))

/** "Sisa tagihan": what is left to cover, floored at zero. A cash line counts at what was handed over. */
export function remainingDue(due: number, lines: readonly TenderLine[]): number {
  return fromCents(Math.max(0, toCents(due) - toCents(tenderedTotal(lines))))
}

/** The bill is covered (within the Rp1 tolerance), so Konfirmasi may be enabled. */
export const isCovered = (due: number, lines: readonly TenderLine[]): boolean => toCents(due) - toCents(tenderedTotal(lines)) <= TOLERANCE_CENTS

export type AddLineResult = { ok: true; lines: TenderLine[] } | { ok: false; reason: 'full' | 'covered' | 'amount' | 'invalid' }

/**
 * Add a line to the entered ones (plan 2.7). A non-cash amount is capped at Sisa; a second cash entry is added INTO
 * the existing cash line (so the list never holds two cash lines); at N lines only a cash top-up is still possible;
 * once Sisa is 0 nothing more can be added; an amount under Rp1 is refused. Pure: returns a new list.
 */
export function addTenderLine(
  lines: readonly TenderLine[],
  next: TenderLine,
  due: number,
  isCash: (method: string) => boolean,
): AddLineResult {
  const sisa = remainingDue(due, lines)
  if (sisa <= 0 || isCovered(due, lines)) return { ok: false, reason: 'covered' }
  if (!Number.isFinite(next.amount) || toCents(next.amount) < 100) return { ok: false, reason: 'amount' }
  const reference = next.reference?.trim() ? next.reference.trim() : undefined
  if (isCash(next.method)) {
    const at = lines.findIndex((l) => isCash(l.method))
    if (at >= 0) {
      const out = lines.map((l, i) => (i === at ? { ...l, amount: fromCents(toCents(l.amount) + toCents(next.amount)) } : l))
      return { ok: true, lines: out }
    }
  }
  if (lines.length >= MAX_TENDER_LINES) return { ok: false, reason: 'full' }
  const amount = isCash(next.method) ? next.amount : Math.min(next.amount, sisa)
  return { ok: true, lines: [...lines, { method: next.method, amount, ...(reference ? { reference } : {}) }] }
}

/** A stale-plan check: what blocks Konfirmasi when the total changed under the entered lines (plan 2.7). null = fine. */
export function splitBlockReason(due: number, lines: readonly TenderLine[], isCash: (method: string) => boolean, labelOf: (method: string) => string): string | null {
  if (lines.length === 0) return 'Belum ada pembayaran'
  const nonCash = lines.filter((l) => !isCash(l.method))
  const nonCashC = nonCash.reduce((s, l) => s + toCents(l.amount), 0)
  if (nonCashC > toCents(due) + TOLERANCE_CENTS) {
    const names = [...new Set(nonCash.map((l) => labelOf(l.method)))].join(', ')
    return `Total berubah, hapus pembayaran ${names} lalu masukkan lagi`
  }
  if (!isCovered(due, lines)) return 'Pembayaran belum menutup tagihan'
  return null
}

export interface SalePlanInput {
  /** The sheet is in split mode (the entered `tenders` are the payment). */
  splitMode: boolean
  /** Split mode: the entered lines. */
  tenders: readonly TenderLine[]
  /** Single mode: the chosen method, the typed cash amount (raw) and the optional reference. */
  method: string
  amountInput: string
  reference: string
  /** The order total at tap time (after points). */
  due: number
  isCash: (method: string) => boolean
  labelOf: (method: string) => string
}

export type SalePlan =
  | {
      ok: true
      /** The wire `tenders` (also for a one-method sale: length 1). */
      lines: TenderLine[]
      /** The scalar summary the payload still carries. */
      paymentMethod: string
      amountPaid: number
      change: number
      split: boolean
    }
  | { ok: false; reason: string }

/**
 * The payment of a sale, judged at tap time against `due` (never trimmed to fit: a stale plan is refused, as
 * planRefundSubmit does). Single mode keeps today's scalars byte for byte; split mode allocates the entered lines
 * and refuses anything that is short, over-charged or two-cash.
 */
export function planSaleTender(input: SalePlanInput): SalePlan {
  const ref = input.reference.trim()
  if (!input.splitMode) {
    const t = cashTender(input.isCash(input.method), input.amountInput, input.due)
    if (t.isShort) return { ok: false, reason: 'Uang tunai yang diterima kurang dari total' }
    const line: TenderLine = { method: input.method, amount: t.amountPaid, ...(ref && !input.isCash(input.method) ? { reference: ref } : {}) }
    const bad = tenderStructureError([line])
    if (bad) return { ok: false, reason: bad }
    return { ok: true, lines: [line], paymentMethod: input.method, amountPaid: t.amountPaid, change: t.change, split: false }
  }
  const block = splitBlockReason(input.due, input.tenders, input.isCash, input.labelOf)
  if (block) return { ok: false, reason: block }
  const bad = tenderStructureError(input.tenders)
  if (bad) return { ok: false, reason: bad }
  const a = allocateTenders(input.due, input.tenders, input.isCash, 'online')
  if (!a.ok) return { ok: false, reason: a.error }
  if (a.settlement.reason !== '') return { ok: false, reason: 'Pembayaran tidak sesuai total, periksa lagi' }
  const s = a.settlement
  return { ok: true, lines: [...input.tenders], paymentMethod: s.paymentMethod, amountPaid: s.amountPaid, change: s.change, split: s.lines.length > 1 }
}

/** The payment keys of the sale payload: the scalar summary older readers still use, plus the wire `tenders`
 *  (length 1 for a one-method sale, whose scalars are exactly what the single path always sent). */
export function salePaymentFields(plan: Extract<SalePlan, { ok: true }>): { paymentMethod: string; amountPaid: number; tenders: TenderLine[] } {
  return { paymentMethod: plan.paymentMethod, amountPaid: plan.amountPaid, tenders: plan.lines.map((l) => ({ ...l })) }
}

export interface SnapshotTenderLike { method: string; label: string; amount: number; reference?: string }

/** The receipt rows of a plan: shown only for a split or when a reference must print (a plain one-method sale keeps today's single row). */
export function snapshotTenders(plan: Extract<SalePlan, { ok: true }>, labelOf: (method: string) => string): SnapshotTenderLike[] | undefined {
  if (!plan.split && !plan.lines.some((l) => l.reference)) return undefined
  return plan.lines.map((l) => ({ method: l.method, label: labelOf(l.method), amount: l.amount, ...(l.reference ? { reference: l.reference } : {}) }))
}
