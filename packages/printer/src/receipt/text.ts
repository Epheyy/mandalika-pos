// Text helpers shared by the receipt renderer and the other slips. All of them take the paper width
// (`cols`) as a parameter; at 32 they behave exactly like the helpers that used to live in escpos.ts.

/** Whole-Rupiah amount with dot thousands separators ("-" for negatives). */
export function money(n: number): string {
  const v = Math.round(n)
  const sign = v < 0 ? '-' : ''
  return (
    sign +
    Math.abs(v)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  )
}

/** `left` + spaces + `right` across `cols`; a label too long to fit is cut so the amount is never clipped. */
export function pad(left: string, right: string, cols: number): string {
  const space = cols - left.length - right.length
  if (space >= 1) return left + ' '.repeat(space) + right
  const keep = Math.max(0, cols - right.length - 1)
  return left.slice(0, keep) + ' ' + right
}

/** Wrap `text` into at most `maxLines` lines of `cols` characters (word-aware, hard-cut the rest). */
export function wrap(text: string, maxLines: number, cols: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > 0 && out.length < maxLines) {
    if (rest.length <= cols) { out.push(rest); rest = ''; break }
    let cut = rest.lastIndexOf(' ', cols)
    if (cut <= 0) cut = cols
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trim()
  }
  return out
}

/** Centre `text` in `cols` (clipped to `cols` when longer). */
export function center(text: string, cols: number): string {
  if (text.length >= cols) return text.slice(0, cols)
  const left = Math.floor((cols - text.length) / 2)
  return ' '.repeat(left) + text
}

/** A labelled amount row; a label too long to sit beside its amount wraps (2 lines max) and the amount
 *  goes right-aligned on its own line, so neither is ever clipped. */
export function labelRow(emit: (line: string) => void, label: string, amount: string, cols: number): void {
  if (label.length + 1 + amount.length <= cols) { emit(pad(label, amount, cols)); return }
  for (const l of wrap(label, 2, cols)) emit(l)
  emit(pad('', amount, cols))
}

/** "-Rp10.000" style deduction amount (ASCII hyphen: Latin-1 safe). */
export const minusRp = (n: number): string => '-Rp' + money(n)

/** Latin-1 byte encoding, exactly as the printer has always received it. U+00B7 (the middle dot in a bundle
 *  name) is a box glyph on the printer code page, so it prints a hyphen; anything above 0xFF prints '?'. */
export function encodeLegacy(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    out.push(c === 0xb7 ? 0x2d : c > 0xff ? 0x3f : c)
  }
  return out
}

const PUNCT_MAP: Readonly<Record<string, string>> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-',
  '…': '...',
  '·': '-',
  ' ': ' ',
}

/** Printer-safe text for designer layouts: NFKD, no combining marks, typographic punctuation folded to
 *  ASCII, and anything else outside 0x20-0x7E (newline excepted) becomes '?'. The result only holds
 *  characters the code page prints, so it can be laid out before it is encoded. */
export function toPrinterText(text: string): string {
  let out = ''
  for (const ch of text.normalize('NFKD')) {
    if (/[̀-ͯ]/.test(ch)) continue
    const mapped = PUNCT_MAP[ch]
    if (mapped !== undefined) { out += mapped; continue }
    const c = ch.codePointAt(0) as number
    out += (c >= 0x20 && c <= 0x7e) || ch === '\n' ? ch : '?'
  }
  return out
}
