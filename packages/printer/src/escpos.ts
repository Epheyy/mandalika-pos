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
  /** Variant/size — printed on its own indented line so it never clips. */
  variant?: string
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
  reprint = false,
): Uint8Array {
  const b = new Buf().raw(INIT)

  b.raw(ALIGN_CENTER)
  if (settings.headerText) {
    b.raw(BOLD_ON).raw(DOUBLE_ON).line(settings.headerText).raw(DOUBLE_OFF).raw(BOLD_OFF)
  }
  if (settings.footerText && settings.headerText) b.line()
  b.raw(ALIGN_LEFT)

  if (reprint) reprintLine(b)

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
    if (item.variant) b.line(`  ${item.variant}`.slice(0, COLS))
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

  if (reprint) reprintLine(b)

  b.raw(FEED_3).raw(CUT)
  return b.done()
}

// ── Shift recap slip ─────────────────────────────────────

/** One payment-method reconciliation row on the recap. */
export interface RecapMethodRow {
  label: string
  /** System-computed (Tercatat). */
  recorded: number
  /** Cashier-counted (Terhitung); null when not reconciled. */
  counted: number | null
}

/** Everything needed to print a shift recap (current or a past shift). */
export interface RecapData {
  title: string
  outletName: string
  cashierName: string
  openedAt: Date | null
  closedAt: Date | null
  startingCash: number | null
  closingCash: number | null
  methods: RecapMethodRow[]
  totalRecorded: number
  totalCounted: number | null
  /** Cash in/out — null skips the section (e.g. a past shift's flows aren't loaded). */
  cashIn: number | null
  cashOut: number | null
  /** Refunds this drawer paid for other shifts' sales (A06): printed as a note, already out of Tercatat. */
  crossShiftRefunds?: number
  /** Refunds of this shift's own sales still waiting to sync: printed as a note, already out of Tercatat. */
  unsyncedRefunds?: number
  /** Queued refunds captured without detail (older app): printed as a note, not in the figures. */
  unknownRefundDetailCount?: number
  /** Refunds parked for review: count and amount are printed as a note, NOT out of Tercatat (the server never counted them). */
  parkedRefundCount?: number
  parkedRefundTotal?: number
  gross: number
  refundTotal: number
  refundCount: number
  discount: number
  surcharge: number
  net: number
  tax: number
  totalSales: number
  totalOrders: number
  generatedAt: Date
}

/** Build the ESC/POS payload for a shift recap slip (one copy). */
export function buildRecap(data: RecapData, settings: ReceiptSettings): Uint8Array {
  const b = new Buf().raw(INIT)
  const dt = (d: Date) =>
    d.toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    })

  b.raw(ALIGN_CENTER)
  if (settings.headerText) {
    b.raw(BOLD_ON).raw(DOUBLE_ON).line(settings.headerText).raw(DOUBLE_OFF).raw(BOLD_OFF)
  }
  b.raw(BOLD_ON).line(data.title).raw(BOLD_OFF)
  b.raw(ALIGN_LEFT)

  b.line(pad('Outlet', data.outletName))
  b.line(pad('Kasir', data.cashierName))
  if (data.openedAt) b.line(pad('Buka', dt(data.openedAt)))
  if (data.closedAt) b.line(pad('Tutup', dt(data.closedAt)))
  if (data.startingCash != null) b.line(pad('Kas Awal', money(data.startingCash)))
  if (data.closingCash != null) b.line(pad('Kas Akhir', money(data.closingCash)))
  b.divider()

  b.raw(BOLD_ON).line('PEMBAYARAN').raw(BOLD_OFF)
  for (const m of data.methods) {
    b.line(m.label.slice(0, COLS))
    b.line(pad('  Tercatat', money(m.recorded)))
    if (m.counted != null) {
      b.line(pad('  Terhitung', money(m.counted)))
      const diff = m.counted - m.recorded
      if (diff !== 0) b.line(pad('  Selisih', (diff > 0 ? '+' : '') + money(diff)))
    }
  }
  b.raw(BOLD_ON).line(pad('Total Tercatat', money(data.totalRecorded))).raw(BOLD_OFF)
  if (data.crossShiftRefunds) b.line(pad('Refund transaksi shift lain', '-' + money(data.crossShiftRefunds)))
  if (data.unsyncedRefunds) b.line(pad('Refund belum tersinkron', '-' + money(data.unsyncedRefunds)))
  if (data.unknownRefundDetailCount) {
    b.line(`Refund tanpa detail: ${data.unknownRefundDetailCount}`)
    b.line('  (tidak dihitung)')
  }
  if (data.parkedRefundCount) {
    b.line(`Refund perlu ditinjau: ${data.parkedRefundCount}`)
    b.line(pad('  jumlah', money(data.parkedRefundTotal ?? 0)))
  }
  if (data.totalCounted != null) {
    b.line(pad('Total Terhitung', money(data.totalCounted)))
    const d = data.totalCounted - data.totalRecorded
    b.line(pad('Selisih', (d > 0 ? '+' : '') + money(d)))
  }
  b.divider()

  if (data.cashIn != null || data.cashOut != null) {
    b.raw(BOLD_ON).line('UANG MASUK/KELUAR').raw(BOLD_OFF)
    b.line(pad('Uang Masuk', money(data.cashIn ?? 0)))
    b.line(pad('Uang Keluar', money(data.cashOut ?? 0)))
    b.divider()
  }

  b.raw(BOLD_ON).line('PENJUALAN').raw(BOLD_OFF)
  b.line(pad('Transaksi', String(data.totalOrders)))
  if (data.refundCount > 0) b.line(pad('Pengembalian', String(data.refundCount)))
  b.line(pad('Penjualan Kotor', money(data.gross)))
  if (data.refundTotal > 0) b.line(pad('Pengembalian Kotor', '-' + money(data.refundTotal)))
  if (data.discount > 0) b.line(pad('Diskon', '-' + money(data.discount)))
  if (data.surcharge > 0) b.line(pad('Surcharge', money(data.surcharge)))
  b.line(pad('Penjualan Bersih', money(data.net)))
  if (data.tax > 0) b.line(pad('Pajak', money(data.tax)))
  b.raw(BOLD_ON).line(pad('TOTAL', money(data.totalSales))).raw(BOLD_OFF)
  b.divider()

  b.raw(ALIGN_CENTER).line('Dicetak ' + dt(data.generatedAt))
  if (settings.footerText) b.line().line(settings.footerText.slice(0, COLS))
  b.raw(ALIGN_LEFT).raw(FEED_3).raw(CUT)
  return b.done()
}

export { center, money, pad }

// ── Tanda terima slip (SP4) ──────────────────────────────

/** One row in a tanda terima items table (already received + diffed). */
export interface TandaTerimaLine {
  productName: string
  variant: string       // e.g. '50ml'
  sentQty: number
  receivedQty: number
  difference: number    // receivedQty - sentQty
}

/** Everything needed to print one tanda terima slip. */
export interface TandaTerimaData {
  tandaTerimaNo: string             // 'TT-2026-00001'
  transferNo: string                // 'TRF-00005'
  receivedAt: Date
  /** Receiver letterhead lines, brand or per-location override. First line is
   *  the brand/location name (printed bold + centered); the rest is address /
   *  phone (centered, normal). */
  receiverHeaderLines: string[]
  senderName: string                // 'Gudang Pusat'
  items: TandaTerimaLine[]
  discrepancyReason: string | null
  receivedByName: string
}

/** Build the ESC/POS payload for a tanda terima (one copy).
 *
 *  Column math (locked, total = 32 chars on 58 mm / Font A):
 *    Header line: ' '.repeat(19) + 'Krm' + '  ' + 'Trm' + '  ' + 'Sel' = 19+3+2+3+2+3 = 32
 *    Row line:    '  ' (indent 2) + variant.padEnd(17) + krm(3) + '  ' + trm(3) + '  ' + sel(3) = 2+17+3+2+3+2+3 = 32
 *      (Exact for |krm|,|trm|<=999 and |sel|<=99. When |difference|>=100, sel
 *       widens to 4 chars and the row wraps to a second line — acceptable, since
 *       truncating would mislead the cashier about the actual shortfall.)
 *  productName renders on its own preceding line via b.line(...slice(0, COLS)).
 */
export function buildTandaTerima(
  data: TandaTerimaData,
  settings: ReceiptSettings,
  reprint = false,
): Uint8Array {
  const b = new Buf().raw(INIT)
  const dt = (d: Date) =>
    d.toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })

  // Letterhead (centered). First non-empty line bold; rest normal.
  const head = data.receiverHeaderLines.filter((l) => l && l.trim().length > 0)
  if (head.length > 0) {
    b.raw(ALIGN_CENTER)
    b.raw(BOLD_ON).line(head[0].slice(0, COLS)).raw(BOLD_OFF)
    for (const l of head.slice(1)) b.line(l.slice(0, COLS))
  }
  b.divider()
  b.raw(BOLD_ON).line(center('TANDA TERIMA')).raw(BOLD_OFF)
  b.divider()
  b.raw(ALIGN_LEFT)

  if (reprint) reprintLine(b)

  b.line(pad('No', data.tandaTerimaNo))
  b.line(pad('Ref', data.transferNo))
  b.line(pad('Tgl', dt(data.receivedAt)))
  b.line(pad('Dari', data.senderName))
  b.divider()

  // K/T/S column header — total must equal 32:
  // 19 leading spaces + 'Krm' + '  ' + 'Trm' + '  ' + 'Sel' = 19+3+2+3+2+3 = 32.
  b.line(' '.repeat(19) + 'Krm' + '  ' + 'Trm' + '  ' + 'Sel')

  for (const it of data.items) {
    b.line(it.productName.slice(0, COLS))
    // '  ' indent (2) + variant.padEnd(17) + krm(3) + '  ' + trm(3) + '  ' + sel(3) = 32.
    const krm = String(it.sentQty).padStart(3)
    const trm = String(it.receivedQty).padStart(3)
    const sel = (it.difference > 0 ? '+' : '') + String(it.difference)
    b.line(
      '  ' +
        it.variant.padEnd(17).slice(0, 17) +
        krm +
        '  ' +
        trm +
        '  ' +
        sel.padStart(3),
    )
  }
  b.divider()

  if (data.discrepancyReason && data.discrepancyReason.trim().length > 0) {
    b.line('Selisih: ' + data.discrepancyReason)
    b.divider()
  }

  b.line('Diterima oleh: ' + data.receivedByName)
  b.line()
  b.line()
  b.line('_'.repeat(COLS))
  b.line(center('Tanda Tangan'))
  b.line()

  b.raw(ALIGN_CENTER).line('Dicetak ' + dt(new Date()))
  if (settings.footerText) b.line().line(settings.footerText.slice(0, COLS))
  b.raw(ALIGN_LEFT)
  if (reprint) reprintLine(b)
  b.raw(FEED_3).raw(CUT)
  return b.done()
}
