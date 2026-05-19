// ESC/POS byte-buffer builder for 58 mm thermal printers (plan §6).
// Target hardware confirmed with the operator: I-Ware C5813 (58 mm, generic
// ESC/POS). 58 mm at Font A = 32 characters per line. Layout mirrors the
// on-screen ReceiptPreview so the printed slip matches what the cashier sees.

import type { components } from '@mandalika/api'

type ReceiptSettings = components['schemas']['ReceiptSettings']

/** Paper geometry for the I-Ware C5813 (58 mm, Font A). */
export const COLS = 32

/** One printable line of a receipt (already priced, server- or client-side). */
export interface ReceiptLine {
  name: string
  qty: number
  /** Per-unit price in whole Rupiah. */
  unitPrice: number
  /** Line total in whole Rupiah. */
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
  discountAmount: number
  taxAmount: number
  total: number
  paymentLabel: string
  amountPaid: number
  change: number
  customerName: string | null
  customerPhone: string | null
  cashierName: string
}

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

function center(text: string): string {
  if (text.length >= COLS) return text.slice(0, COLS)
  const left = Math.floor((COLS - text.length) / 2)
  return ' '.repeat(left) + text
}

/** Latin-1 byte encoding — Indonesian receipt text is ASCII-safe. */
function bytes(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    out.push(c > 0xff ? 0x3f : c) // unknown glyph → '?'
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
export function buildReceipt(
  data: ReceiptData,
  settings: ReceiptSettings,
): Uint8Array {
  const b = new Buf().raw(INIT)

  b.raw(ALIGN_CENTER)
  if (settings.headerText) {
    b.raw(BOLD_ON).raw(DOUBLE_ON).line(settings.headerText).raw(DOUBLE_OFF).raw(BOLD_OFF)
  }
  if (settings.footerText && settings.headerText) b.line()
  b.raw(ALIGN_LEFT)

  // The receipt always shows the order id. Sync state is an app concern, not
  // something the customer's printed receipt should announce.
  if (settings.showOrderNumber !== false) b.line(pad('No', data.orderRef))
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
    b.line(item.name.slice(0, COLS))
    b.line(pad(`  ${item.qty} x ${money(item.unitPrice)}`, money(item.amount)))
  }
  b.divider()

  if (settings.showSubtotal !== false) b.line(pad('Subtotal', money(data.subtotal)))
  if (settings.showDiscount !== false && data.discountAmount > 0) {
    b.line(pad('Diskon', '-' + money(data.discountAmount)))
  }
  if (settings.showTax && data.taxAmount > 0) {
    b.line(pad('PPN', money(data.taxAmount)))
  }
  b.raw(BOLD_ON).line(pad('TOTAL', money(data.total))).raw(BOLD_OFF)
  b.line(pad(data.paymentLabel, money(data.amountPaid)))
  if (settings.showChange !== false && data.change > 0) {
    b.line(pad('Kembalian', money(data.change)))
  }
  b.divider()

  if (settings.showCustomerName !== false && data.customerName) {
    b.line('Pelanggan: ' + data.customerName)
  }
  if (settings.showCustomerPhone && data.customerPhone) {
    b.line('Telp: ' + data.customerPhone)
  }
  if (settings.showCashier) b.line('Kasir: ' + data.cashierName)

  if (settings.footerText) {
    b.line().raw(ALIGN_CENTER).line(settings.footerText).raw(ALIGN_LEFT)
  }

  b.raw(FEED_3).raw(CUT)
  return b.done()
}

export { center, money, pad }
