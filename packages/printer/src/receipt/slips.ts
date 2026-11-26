// The DIBATALKAN slip's data and body lines (moved from escpos.ts, which re-exports them). Pure.

import type { ReceiptData } from './data'
import type { ReceiptLayout } from './layout'
import { playBlock, resolveCols, type RenderOptions } from './render'
import { EscPosSink, type ReceiptSink } from './sink'
import { labelRow, money, pad, toPrinterText } from './text'
import type { BlockCtx } from './blocks'

/** Everything the DIBATALKAN slip prints. */
export interface VoidSlipData {
  /** Number of the voided sale. */
  orderRef: string
  total: number
  reasonLabel: string
  note?: string
  voidedBy: string
  dateTime: string
  /** Number of the replacement sale, when one exists yet. */
  replacementRef?: string
  /** The outlet's details, for a template header that shows them. Absent = the header prints without them. */
  outlet?: ReceiptData['outlet']
}

/** Printer-safe text for this slip: accents folded to ASCII (the code page prints them as box glyphs), middle dot to a
 *  hyphen. Deliberately not `toPrinterText` from text.ts: that one also maps unknown glyphs to '?', which would change
 *  bytes this slip already prints. */
function voidPrinterText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/·/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    // A control byte in a note would reach the printer as a command.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
}

/** Hard-wrap `text` at `cols` characters (word-aware, no line limit). */
function wrapAt(text: string, cols: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > cols) {
    let cut = rest.lastIndexOf(' ', cols)
    if (cut <= 0) cut = cols
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0 || out.length === 0) out.push(rest)
  return out
}

/** The body of the DIBATALKAN slip, wrapped at `cols`. Pure. */
export function voidSlipLines(data: VoidSlipData, cols: number): string[] {
  const rows = [
    `No: #${data.orderRef}`,
    `Total: ${money(data.total)}`,
    `Alasan: ${data.reasonLabel}`,
    ...(data.note ? [`Catatan: ${data.note}`] : []),
    `Oleh: ${data.voidedBy}`,
    `Waktu: ${data.dateTime}`,
    ...(data.replacementRef ? [`Pengganti: #${data.replacementRef}`] : []),
  ]
  return rows.flatMap((r) => wrapAt(voidPrinterText(r), cols))
}

/** Everything the REFUND slip prints. */
export interface RefundSlipData {
  orderRef: string
  dateTime: Date
  /** The returned lines. Each amount is what that line pays back; together they add up to `total`. */
  lines: { name: string; variant?: string; qty: number; amount: number }[]
  /** A signed row for what the lines do not cover (an order discount, tax, rounding). Printed under the lines, so
   *  lines + adjustment = total. Absent when the lines already add up. */
  adjustment?: { label: string; amount: number }
  total: number
  /** The method the money goes back through ("Tunai", "QRIS"). */
  payoutLabel: string
  reasonLabel?: string
  cashierName: string
  outlet?: ReceiptData['outlet']
  /** A18: the outlet the sale was made at, printed as "Transaksi asal" when a return is made at another outlet. */
  originOutlet?: string
}

export type SlipStamp = 'REFUND' | 'DIBATALKAN'

/** One line of data text: printable ASCII, no newline. */
const clean = (s: string): string => toPrinterText(String(s ?? '')).replace(/\n/g, ' ')

/** A slip's header run: the layout's leading image/header blocks (a block that fails is skipped), a divider, the
 *  big stamp, a divider. Only those two block types: the rest of a sale receipt means nothing on a slip. */
function frame(layout: ReceiptLayout, stamp: SlipStamp, outlet: ReceiptData['outlet'], sink: ReceiptSink, opts: RenderOptions): number {
  const cols = resolveCols(layout, opts)
  const compat = layout.compat === 'v1'
  // The header block reads only `data.outlet`; a Standar header ignores even that. A malformed outlet drops the
  // outlet rows (reported), never the slip.
  let safeOutlet: ReceiptData['outlet']
  try {
    const opt = (v: string | null | undefined): string | null | undefined => (typeof v === 'string' ? clean(v) : v)
    safeOutlet = outlet ? { name: clean(outlet.name), address: opt(outlet.address), phone: opt(outlet.phone) } : undefined
  } catch (e) {
    opts.onBlockError?.('outlet', e)
  }
  const data = { outlet: safeOutlet } as ReceiptData
  const ctx: BlockCtx = { out: sink, cols, compat, graphics: opts.graphics !== false, data }
  sink.cmd('init')
  for (const b of layout.blocks) {
    // Disabled blocks are not part of the run, as in renderReceipt.
    if (!b.enabled) continue
    if (b.type !== 'header' && b.type !== 'image') break
    playBlock(b, ctx, sink, opts)
  }
  sink.line('-'.repeat(cols))
  sink.cmd('alignCenter'); sink.cmd('boldOn'); sink.cmd('largeOn')
  sink.line(stamp)
  sink.cmd('largeOff'); sink.cmd('boldOff'); sink.cmd('alignLeft')
  sink.line('-'.repeat(cols))
  return cols
}

/** The DIBATALKAN slip framed by `layout`: its logo/header, the stamp, then the same body lines as `buildVoidSlip`. */
export function voidSlipBytes(layout: ReceiptLayout, data: VoidSlipData, opts: RenderOptions = {}): Uint8Array {
  const sink = new EscPosSink()
  const cols = frame(layout, 'DIBATALKAN', data.outlet, sink, opts)
  for (const l of voidSlipLines(data, cols)) sink.line(l)
  sink.cmd('feed3'); sink.cmd('cut')
  return sink.done()
}

/** The body of the REFUND slip, wrapped at `cols`; the TOTAL REFUND row is bold, so it is reported by index. */
function refundBody(data: RefundSlipData, cols: number): { text: string; bold?: boolean }[] {
  const out: { text: string; bold?: boolean }[] = []
  const emit = (text: string, bold?: boolean): void => { out.push({ text, bold }) }
  for (const l of wrapAt(`No: #${clean(data.orderRef)}`, cols)) emit(l)
  const when = data.dateTime.toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  for (const l of wrapAt(`Tgl: ${clean(when)}`, cols)) emit(l)
  if (data.originOutlet) for (const l of wrapAt(`Transaksi asal: ${clean(data.originOutlet)}`, cols)) emit(l)
  for (const ln of data.lines) {
    const name = clean([ln.name, ln.variant].filter(Boolean).join(' '))
    labelRow((t) => emit(t), `${ln.qty} x ${name}`, money(ln.amount), cols)
  }
  if (data.adjustment && data.adjustment.amount !== 0) labelRow((t) => emit(t), clean(data.adjustment.label), money(data.adjustment.amount), cols)
  emit('-'.repeat(cols))
  emit(pad('TOTAL REFUND', money(data.total), cols), true)
  for (const l of wrapAt(`Dikembalikan lewat ${clean(data.payoutLabel)}`, cols)) emit(l)
  if (data.reasonLabel) for (const l of wrapAt(`Alasan: ${clean(data.reasonLabel)}`, cols)) emit(l)
  for (const l of wrapAt(`Kasir: ${clean(data.cashierName)}`, cols)) emit(l)
  return out
}

/** The REFUND slip framed by `layout`. Printed once, after the refund is saved on the tablet. */
export function refundSlipBytes(layout: ReceiptLayout, data: RefundSlipData, opts: RenderOptions = {}): Uint8Array {
  const sink = new EscPosSink()
  const cols = frame(layout, 'REFUND', data.outlet, sink, opts)
  for (const row of refundBody(data, cols)) {
    if (row.bold) sink.cmd('boldOn')
    sink.line(row.text)
    if (row.bold) sink.cmd('boldOff')
  }
  sink.cmd('feed3'); sink.cmd('cut')
  return sink.done()
}
