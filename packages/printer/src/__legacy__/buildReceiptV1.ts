// FROZEN: a verbatim copy of buildReceipt (with Void's rows) as of origin/prod-hardening e61e6937.
// Production code: the fallback when a receipt layout cannot render, and the reference for the differential
// tests. It shares no code with the block renderer on purpose. NEVER edit it after the receipt-designer
// Phase 1 freeze (the sanctioned exception, Void's rows, was already folded in at this base).

import type { components } from '@mandalika/api'
import { resolveReceiptFlags } from '@mandalika/types'
import type { ReceiptData } from '../receipt/data'

type ReceiptSettings = components['schemas']['ReceiptSettings']

const COLS = 32

// ── ESC/POS control codes ────────────────────────────────
const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

const INIT = [ESC, 0x40] // initialize printer
const ALIGN_LEFT = [ESC, 0x61, 0x00]
const ALIGN_CENTER = [ESC, 0x61, 0x01]
const BOLD_ON = [ESC, 0x45, 0x01]
const BOLD_OFF = [ESC, 0x45, 0x00]
const DOUBLE_ON = [GS, 0x21, 0x11] // double width + height
const DOUBLE_OFF = [GS, 0x21, 0x00]
const FEED_3 = [ESC, 0x64, 0x03] // feed 3 lines
const CUT = [GS, 0x56, 0x42, 0x00] // partial cut (ignored if unsupported)

function money(n: number): string {
  const v = Math.round(n)
  const sign = v < 0 ? '-' : ''
  return (
    sign +
    Math.abs(v)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  )
}

function pad(left: string, right: string): string {
  const space = COLS - left.length - right.length
  if (space >= 1) return left + ' '.repeat(space) + right
  // Truncate the label so the amount is never clipped.
  const keep = Math.max(0, COLS - right.length - 1)
  return left.slice(0, keep) + ' ' + right
}

/** Wrap `text` into at most `maxLines` lines of COLS characters (word-aware, hard-cut the rest). */
function wrap(text: string, maxLines: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > 0 && out.length < maxLines) {
    if (rest.length <= COLS) { out.push(rest); rest = ''; break }
    let cut = rest.lastIndexOf(' ', COLS)
    if (cut <= 0) cut = COLS
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trim()
  }
  return out
}

/** A labelled amount row; a label too long to sit beside its amount wraps (2 lines max) and the amount
 *  goes right-aligned on its own line, so neither is ever clipped. */
function labelRow(b: Buf, label: string, amount: string): void {
  if (label.length + 1 + amount.length <= COLS) { b.line(pad(label, amount)); return }
  const parts = wrap(label, 2)
  for (const l of parts) b.line(l)
  b.line(pad('', amount))
}

/** "-Rp10.000" style deduction amount (ASCII hyphen: Latin-1 safe). */
const minusRp = (n: number): string => '-Rp' + money(n)

/** Centered bold marker printed top + bottom on a reprinted copy so staff can
 *  tell a duplicate apart from the original slip. */
const REPRINT_MARK = '*** CETAK ULANG (REPRINT) ***'
function reprintLine(b: Buf): void {
  b.raw(ALIGN_CENTER).raw(BOLD_ON).line(REPRINT_MARK).raw(BOLD_OFF).raw(ALIGN_LEFT)
}

/** Latin-1 byte encoding — Indonesian receipt text is ASCII-safe. */
function bytes(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // U+00B7 (the middle dot in a bundle name) is a box glyph on the printer code page: print a hyphen instead.
    out.push(c === 0xb7 ? 0x2d : c > 0xff ? 0x3f : c) // unknown glyph → '?'
  }
  return out
}

class Buf {
  private parts: number[] = []
  raw(codes: number[]): this {
    this.parts.push(...codes)
    return this
  }
  line(text = ''): this {
    this.parts.push(...bytes(text), LF)
    return this
  }
  divider(): this {
    return this.line('-'.repeat(COLS))
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

/**
 * Build the ESC/POS payload for one receipt copy. `settings.receipt` toggles
 * the same optional rows the HTML preview honors (tax/cashier/customer/etc.).
 */
export function buildReceiptV1(
  data: ReceiptData,
  settings: ReceiptSettings,
  reprint = false,
): Uint8Array {
  const b = new Buf().raw(INIT)
  const flags = resolveReceiptFlags(settings)

  b.raw(ALIGN_CENTER)
  if (settings.headerText) {
    b.raw(BOLD_ON).raw(DOUBLE_ON).line(settings.headerText).raw(DOUBLE_OFF).raw(BOLD_OFF)
  }
  if (settings.footerText && settings.headerText) b.line()
  b.raw(ALIGN_LEFT)

  if (reprint) reprintLine(b)

  if (data.replacesOrderRef) for (const l of wrap(`Pengganti untuk #${data.replacesOrderRef}`, 2)) b.line(l)

  // The receipt always shows the order id. Sync state is an app concern, not
  // something the customer's printed receipt should announce.
  if (flags.showOrderNumber) b.line(pad('No', data.orderRef))
  b.line(
    pad(
      'Tgl',
      data.dateTime.toLocaleString('id-ID', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
    ),
  )
  b.divider()

  for (const item of data.lines) {
    const tag = item.isReward ? ` [${(item.rewardLabel ?? 'HADIAH').toUpperCase()}]` : ''
    for (const l of wrap(item.name + tag, 2)) b.line(l)
    if (item.variant) b.line(`  ${item.variant}`.slice(0, COLS))
    for (const piece of item.pieces ?? []) {
      // Indented bullet (wrap() would trim it); a name longer than the paper continues on one indented line.
      const text = `  + ${piece}`
      b.line(text.slice(0, COLS))
      if (text.length > COLS) b.line(`    ${text.slice(COLS)}`.slice(0, COLS))
    }
    // A giveaway at Rp0 prints GRATIS (as the screen does), never a bare "0".
    const gross = item.amount + (item.lineDiscount?.amount ?? 0)
    const amountText = item.isReward && item.amount === 0 ? 'GRATIS' : money(gross)
    b.line(pad(`  ${item.qty} x ${money(item.unitPrice)}`, amountText))
    if (item.lineDiscount && item.lineDiscount.amount > 0) labelRow(b, `  - ${item.lineDiscount.label}`, minusRp(item.lineDiscount.amount))
  }
  b.divider()

  if (flags.showSubtotal) b.line(pad('Subtotal', money(data.subtotal)))
  // An itemised (C1) slip always prints its deductions and PPN: hiding a row that is inside TOTAL would
  // make the slip not add up. The Pengaturan toggles still govern pre-C1 receipts.
  const itemised = data.discounts !== undefined
  if (itemised || flags.showDiscount) {
    if (data.discounts) {
      for (const d of data.discounts) if (d.amount > 0) labelRow(b, `- ${d.label}`, minusRp(d.amount))
    } else if (data.discountAmount > 0) {
      // Pre-C1 archived receipt: no per-promo detail, keep today's single row.
      b.line(pad('Diskon', '-' + money(data.discountAmount)))
    }
  }
  if (data.surcharge && data.surcharge > 0) b.line(pad('Biaya tambahan', money(data.surcharge)))
  if (data.pointsRedeemed && data.pointsRedeemed.amount > 0) {
    b.line(pad(`Tukar poin (${data.pointsRedeemed.points})`, minusRp(data.pointsRedeemed.amount)))
  }
  if ((itemised || flags.showTax) && data.taxAmount > 0) {
    b.line(pad('PPN', money(data.taxAmount)))
  }
  if (data.rounding) b.line(pad('Pembulatan', (data.rounding > 0 ? '+' : '') + money(data.rounding)))
  // Void: a signed correction sits inside TOTAL, so it prints whatever the totals switches say.
  if (data.correctionAmount) b.line(pad('Penyesuaian koreksi', (data.correctionAmount > 0 ? '+' : '') + money(data.correctionAmount)))
  b.raw(BOLD_ON).line(pad('TOTAL', money(data.total))).raw(BOLD_OFF)
  if (data.tenders && data.tenders.length > 0) {
    for (const t of data.tenders) {
      b.line(pad(t.label, money(t.amount)))
      if (t.reference) b.line(`  Ref ${t.reference}`.slice(0, COLS))
    }
  } else {
    b.line(pad(data.paymentLabel, money(data.amountPaid)))
  }
  if (flags.showChange && data.change > 0) {
    b.line(pad('Kembalian', money(data.change)))
  }
  b.divider()

  if (flags.showCustomerName && data.customerName) {
    b.line('Pelanggan: ' + data.customerName)
  }
  if (flags.showCustomerPhone && data.customerPhone) {
    b.line('Telp: ' + data.customerPhone)
  }
  if (flags.showCashier) b.line('Kasir: ' + data.cashierName)

  if (settings.footerText) {
    b.line().raw(ALIGN_CENTER).line(settings.footerText).raw(ALIGN_LEFT)
  }

  if (reprint) reprintLine(b)

  b.raw(FEED_3).raw(CUT)
  return b.done()
}
