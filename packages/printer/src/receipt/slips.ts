// The DIBATALKAN slip's data and body lines (moved from escpos.ts, which re-exports them). Pure.

import { money } from './text'

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
