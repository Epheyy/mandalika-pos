// The block renderer: one pass over a layout, writing to a sink. Pure; no Capacitor.

import type { ReceiptData } from './data'
import {
  COLS_BY_WIDTH, isLockedType,
  type PaperWidth, type ReceiptBlock, type ReceiptLayout,
} from './layout'
import {
  dividerBlock, headerBlock, itemsBlock, paymentBlock, pointsBlock, replacementMark, reprintMark, textBlock,
  totalsBlock, transactionBlock, type BlockCtx,
} from './blocks'
import { EscPosSink, PreviewSink, type Cmd, type PreviewLine, type ReceiptSink } from './sink'
import { toPrinterText } from './text'

export interface RenderOptions {
  reprint?: boolean
  /** The tablet's paper width: the layout renders at the narrower of the two. */
  maxPaperWidth?: PaperWidth
  /** An unlocked block threw and was skipped. */
  onBlockError?: (blockId: string, e: unknown) => void
}

/** A locked block (items, totals, payment) threw: the receipt would be wrong, so the whole layout is abandoned. */
export class LockedBlockError extends Error {
  readonly blockId: string
  override readonly cause: unknown
  constructor(blockId: string, cause: unknown) {
    super(`locked receipt block "${blockId}" failed`)
    this.name = 'LockedBlockError'
    this.blockId = blockId
    this.cause = cause
  }
}

/** Characters per line the layout renders at, after the device clamp. */
export function resolveCols(layout: ReceiptLayout, opts: RenderOptions = {}): number {
  const width = Math.min(layout.paperWidth, opts.maxPaperWidth ?? layout.paperWidth) as PaperWidth
  return COLS_BY_WIDTH[width]
}

/** One line of data text for a designer layout: printable ASCII, no newline. */
const clean = (s: string): string => toPrinterText(s).replace(/\n/g, ' ')
const cleanOpt = <T extends string | null | undefined>(s: T): T => (typeof s === 'string' ? (clean(s) as T) : s)

/** Every string the slip prints, mapped to printable ASCII before any pad, wrap or centre, so folding
 *  (for example `…` to `...`) can never lengthen a line after layout. */
export function normalizeForPrint(d: ReceiptData): ReceiptData {
  return {
    ...d,
    orderRef: clean(d.orderRef),
    lines: d.lines.map((l) => ({
      ...l,
      name: clean(l.name),
      variant: cleanOpt(l.variant),
      rewardLabel: cleanOpt(l.rewardLabel),
      pieces: l.pieces?.map(clean),
      lineDiscount: l.lineDiscount ? { ...l.lineDiscount, label: clean(l.lineDiscount.label) } : l.lineDiscount,
    })),
    discounts: d.discounts?.map((x) => ({ ...x, label: clean(x.label) })),
    tenders: d.tenders?.map((t) => ({ ...t, label: clean(t.label), reference: cleanOpt(t.reference) })),
    paymentLabel: clean(d.paymentLabel),
    customerName: cleanOpt(d.customerName),
    customerPhone: cleanOpt(d.customerPhone),
    cashierName: clean(d.cashierName),
    replacesOrderRef: cleanOpt(d.replacesOrderRef),
    outlet: d.outlet
      ? { name: clean(d.outlet.name), address: cleanOpt(d.outlet.address), phone: cleanOpt(d.outlet.phone) }
      : d.outlet,
  }
}

/** Records a sink's calls so a block that throws half way leaves nothing behind. */
class Recorder implements ReceiptSink {
  private ops: Array<{ c: Cmd } | { t: string | undefined }> = []
  cmd(c: Cmd): void { this.ops.push({ c }) }
  line(text?: string): void { this.ops.push({ t: text }) }
  replayTo(sink: ReceiptSink): void {
    for (const op of this.ops) {
      if ('c' in op) sink.cmd(op.c)
      else sink.line(op.t)
    }
  }
}

function runBlock(b: ReceiptBlock, ctx: BlockCtx): void {
  switch (b.type) {
    case 'header': return headerBlock(b, ctx)
    case 'transaction': return transactionBlock(b, ctx)
    case 'items': return itemsBlock(ctx)
    case 'totals': return totalsBlock(b, ctx)
    case 'payment': return paymentBlock(b, ctx)
    case 'points': return pointsBlock(ctx)
    case 'text': return textBlock(b, ctx)
    case 'divider': return dividerBlock(ctx)
    default: throw new Error(`unknown receipt block type "${(b as { type: string }).type}"`)
  }
}

/** Render `layout` for `data` into `sink`. An unlocked block that throws is skipped (and reported through
 *  `onBlockError`); a locked block that throws raises LockedBlockError. */
export function renderReceipt(layout: ReceiptLayout, data: ReceiptData, sink: ReceiptSink, opts: RenderOptions = {}): void {
  const compat = layout.compat === 'v1'
  const ctx: BlockCtx = {
    out: sink, cols: resolveCols(layout, opts), compat, data: compat ? data : normalizeForPrint(data),
  }
  const blocks = layout.blocks.filter((b) => b.enabled || isLockedType(b.type))

  sink.cmd('init')
  // The marks sit after the leading run of header blocks.
  let i = 0
  const play = (b: ReceiptBlock): void => {
    const rec = new Recorder()
    try {
      runBlock(b, { ...ctx, out: rec })
    } catch (e) {
      if (isLockedType(b.type)) throw new LockedBlockError(b.id, e)
      opts.onBlockError?.(b.id, e)
      return
    }
    rec.replayTo(sink)
  }
  while (i < blocks.length && blocks[i]!.type === 'header') play(blocks[i++]!)
  if (opts.reprint) reprintMark(sink)
  replacementMark(ctx)
  for (; i < blocks.length; i++) play(blocks[i]!)

  if (opts.reprint) reprintMark(sink)
  sink.cmd('feed3')
  sink.cmd('cut')
}

export function receiptBytes(layout: ReceiptLayout, data: ReceiptData, opts?: RenderOptions): Uint8Array {
  const sink = new EscPosSink()
  renderReceipt(layout, data, sink, opts)
  return sink.done()
}

export function receiptPreview(layout: ReceiptLayout, data: ReceiptData, opts?: RenderOptions): PreviewLine[] {
  const sink = new PreviewSink(resolveCols(layout, opts))
  renderReceipt(layout, data, sink, opts)
  return sink.done()
}
