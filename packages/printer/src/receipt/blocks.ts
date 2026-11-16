// One function per block type. Each writes to a ReceiptSink and knows nothing about the transport.
//
// `ctx.compat` (the Standar layout) reproduces today's bytes exactly: header title, footer and inline rows are
// sent unwrapped. Every other layout wraps all text in software, so no line is wider than the paper.

import type { ReceiptSink, Align } from './sink'
import type { ReceiptData } from './data'
import type { ReceiptBlock, TxField } from './layout'
import { labelRow, minusRp, money, pad, toPrinterText, wrap } from './text'

export interface BlockCtx {
  out: ReceiptSink
  /** Characters per normal-size line. */
  cols: number
  /** Standar: keep today's bytes. */
  compat: boolean
  /** Already normalised (`normalizeForPrint`) unless compat. */
  data: ReceiptData
}

type Of<T extends ReceiptBlock['type']> = Extract<ReceiptBlock, { type: T }>

export const REPRINT_MARK = '*** CETAK ULANG (REPRINT) ***'

/** The date as the printed slip has always shown it. */
function dateText(d: Date): string {
  return d.toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Wrap without a line limit; an empty string prints one blank line. */
function wrapAll(text: string, width: number): string[] {
  const lines = wrap(text, Number.MAX_SAFE_INTEGER, width)
  return lines.length > 0 ? lines : ['']
}

export function reprintMark(out: ReceiptSink): void {
  out.cmd('alignCenter'); out.cmd('boldOn'); out.line(REPRINT_MARK); out.cmd('boldOff'); out.cmd('alignLeft')
}

export function replacementMark(ctx: BlockCtx): void {
  const { out, data, cols, compat } = ctx
  if (!data.replacesOrderRef) return
  for (const l of wrap(`Pengganti untuk #${data.replacesOrderRef}`, compat ? 2 : 3, cols)) out.line(l)
}

function largeLines(out: ReceiptSink, text: string, cols: number, bold: boolean): void {
  if (bold) out.cmd('boldOn')
  out.cmd('largeOn')
  for (const l of wrapAll(text, Math.floor(cols / 2))) out.line(l)
  out.cmd('largeOff')
  if (bold) out.cmd('boldOff')
}

export function headerBlock(b: Of<'header'>, ctx: BlockCtx): void {
  const { out, cols, compat, data } = ctx
  out.cmd('alignCenter')
  if (compat) {
    if (b.text) { out.cmd('boldOn'); out.cmd('largeOn'); out.line(b.text); out.cmd('largeOff'); out.cmd('boldOff') }
    if (b.spaceAfter) out.line()
  } else {
    const title = toPrinterText(b.text).replace(/\n/g, ' ')
    if (title) {
      if (b.size === 'large') largeLines(out, title, cols, true)
      else { out.cmd('boldOn'); for (const l of wrapAll(title, cols)) out.line(l); out.cmd('boldOff') }
    }
    const o = data.outlet
    if (o) {
      if (b.showOutletName && o.name) { out.cmd('boldOn'); for (const l of wrapAll(o.name, cols)) out.line(l); out.cmd('boldOff') }
      if (b.showOutletAddress && o.address) for (const l of wrapAll(o.address, cols)) out.line(l)
      if (b.showOutletPhone && o.phone) for (const l of wrapAll(o.phone, cols)) out.line(l)
    }
  }
  out.cmd('alignLeft')
}

const TX_LABEL: Record<TxField, string> = {
  orderNumber: 'No', date: 'Tgl', cashier: 'Kasir', customerName: 'Pelanggan', customerPhone: 'Telp',
}

function txValue(f: TxField, data: ReceiptData, compat: boolean): string | null {
  switch (f) {
    case 'orderNumber': return data.orderRef
    case 'date': return compat ? dateText(data.dateTime) : toPrinterText(dateText(data.dateTime))
    case 'cashier': return data.cashierName
    case 'customerName': return data.customerName || null
    case 'customerPhone': return data.customerPhone || null
  }
}

export function transactionBlock(b: Of<'transaction'>, ctx: BlockCtx): void {
  const { out, cols, compat, data } = ctx
  for (const f of b.fields) {
    const value = txValue(f, data, compat)
    if (value === null) continue
    if (b.style === 'columns') {
      if (compat || TX_LABEL[f].length + 1 + value.length <= cols) out.line(pad(TX_LABEL[f], value, cols))
      else for (const l of wrapAll(`${TX_LABEL[f]}: ${value}`, cols)) out.line(l)
    } else if (compat) {
      out.line(`${TX_LABEL[f]}: ${value}`)
    } else {
      for (const l of wrapAll(`${TX_LABEL[f]}: ${value}`, cols)) out.line(l)
    }
  }
}

export function itemsBlock(ctx: BlockCtx): void {
  const { out, cols, data } = ctx
  for (const item of data.lines) {
    const tag = item.isReward ? ` [${(item.rewardLabel ?? 'HADIAH').toUpperCase()}]` : ''
    for (const l of wrap(item.name + tag, 2, cols)) out.line(l)
    if (item.variant) out.line(`  ${item.variant}`.slice(0, cols))
    for (const piece of item.pieces ?? []) {
      // Indented bullet (wrap() would trim it); a name longer than the paper continues on one indented line.
      const text = `  + ${piece}`
      out.line(text.slice(0, cols))
      if (text.length > cols) out.line(`    ${text.slice(cols)}`.slice(0, cols))
    }
    // A giveaway at Rp0 prints GRATIS (as the screen does), never a bare "0".
    const gross = item.amount + (item.lineDiscount?.amount ?? 0)
    const amountText = item.isReward && item.amount === 0 ? 'GRATIS' : money(gross)
    out.line(pad(`  ${item.qty} x ${money(item.unitPrice)}`, amountText, cols))
    if (item.lineDiscount && item.lineDiscount.amount > 0) {
      labelRow((l) => out.line(l), `  - ${item.lineDiscount.label}`, minusRp(item.lineDiscount.amount), cols)
    }
  }
}

export function totalsBlock(b: Of<'totals'>, ctx: BlockCtx): void {
  const { out, cols, data } = ctx
  if (b.showSubtotal) out.line(pad('Subtotal', money(data.subtotal), cols))
  // An itemised (C1) slip always prints its deductions and PPN: hiding a row that is inside TOTAL would
  // make the slip not add up. The switches still govern pre-C1 receipts.
  const itemised = data.discounts !== undefined
  if (itemised || b.showDiscount) {
    if (data.discounts) {
      for (const d of data.discounts) if (d.amount > 0) labelRow((l) => out.line(l), `- ${d.label}`, minusRp(d.amount), cols)
    } else if (data.discountAmount > 0) {
      out.line(pad('Diskon', '-' + money(data.discountAmount), cols))
    }
  }
  if (data.surcharge && data.surcharge > 0) out.line(pad('Biaya tambahan', money(data.surcharge), cols))
  if (data.pointsRedeemed && data.pointsRedeemed.amount > 0) {
    out.line(pad(`Tukar poin (${data.pointsRedeemed.points})`, minusRp(data.pointsRedeemed.amount), cols))
  }
  if ((itemised || b.showTax) && data.taxAmount > 0) out.line(pad('PPN', money(data.taxAmount), cols))
  if (data.rounding) out.line(pad('Pembulatan', (data.rounding > 0 ? '+' : '') + money(data.rounding), cols))
  // Void: a signed correction sits inside TOTAL, so it prints whatever the switches say.
  if (data.correctionAmount) {
    out.line(pad('Penyesuaian koreksi', (data.correctionAmount > 0 ? '+' : '') + money(data.correctionAmount), cols))
  }
  out.cmd('boldOn'); out.line(pad('TOTAL', money(data.total), cols)); out.cmd('boldOff')
}

export function paymentBlock(b: Of<'payment'>, ctx: BlockCtx): void {
  const { out, cols, compat, data } = ctx
  if (data.tenders && data.tenders.length > 0) {
    for (const t of data.tenders) {
      out.line(pad(t.label, money(t.amount), cols))
      if (t.reference) out.line(`  Ref ${t.reference}`.slice(0, cols))
    }
  } else {
    out.line(pad(data.paymentLabel, money(data.amountPaid), cols))
  }
  // Change is locked in stored templates; only Standar (compat) honours today's switch.
  const showChange = compat ? b.showChange !== false : true
  if (showChange && data.change > 0) out.line(pad('Kembalian', money(data.change), cols))
}

export function pointsBlock(ctx: BlockCtx): void {
  const { out, cols, data } = ctx
  if (!data.points) return
  out.line(pad('Perkiraan poin', (data.points.earned > 0 ? '+' : '') + money(data.points.earned), cols))
  if (data.points.balance !== null) out.line(pad('Perkiraan saldo', money(data.points.balance), cols))
}

export function dividerBlock(ctx: BlockCtx): void {
  ctx.out.line('-'.repeat(ctx.cols))
}

export function textBlock(b: Of<'text'>, ctx: BlockCtx): void {
  const { out, cols, compat } = ctx
  if (compat) {
    // Standar's footer: sent as one unwrapped line.
    if (b.spaceBefore) out.line()
    alignCmd(out, b.align)
    out.line(b.text)
    out.cmd('alignLeft')
    return
  }
  const width = b.size === 'large' ? Math.floor(cols / 2) : cols
  alignCmd(out, b.align)
  if (b.bold) out.cmd('boldOn')
  if (b.size === 'large') out.cmd('largeOn')
  for (const para of toPrinterText(b.text).split('\n')) for (const l of wrapAll(para, width)) out.line(l)
  if (b.size === 'large') out.cmd('largeOff')
  if (b.bold) out.cmd('boldOff')
  out.cmd('alignLeft')
}

function alignCmd(out: ReceiptSink, a: Align): void {
  out.cmd(a === 'center' ? 'alignCenter' : a === 'right' ? 'alignRight' : 'alignLeft')
}
