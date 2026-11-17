import { COLS_BY_WIDTH, SAMPLE_RECEIPT, receiptPreview, type PreviewLine, type ReceiptLayout } from '@mandalika/printer/render'

/** The preview lines for a layout, or null when the renderer refuses it (a template with a missing locked block). */
export function previewLines(layout: ReceiptLayout): PreviewLine[] | null {
  try {
    return receiptPreview(layout, SAMPLE_RECEIPT)
  } catch {
    return null
  }
}

interface ReceiptPaperProps {
  layout: ReceiptLayout
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const

/** The slip as the tablet prints it: the same renderer, drawn as monospace lines `cols` characters wide.
 *  Large lines take two columns per character, so they are drawn at double size. */
export function ReceiptPaper({ layout }: ReceiptPaperProps) {
  const lines = previewLines(layout)
  const cols = COLS_BY_WIDTH[layout.paperWidth]
  return (
    <div
      data-testid="receipt-paper"
      data-cols={cols}
      aria-label={`Pratinjau struk ${layout.paperWidth}mm`}
      className="mx-auto max-w-full overflow-x-auto bg-white px-3 pt-3.5 pb-5 shadow-[0_10px_26px_rgba(20,24,40,0.14)]"
      style={{ width: `calc(${cols}ch + 1.5rem)`, fontFamily: '"Courier New", ui-monospace, monospace', fontSize: '11px', lineHeight: 1.35, color: '#111' }}
    >
      {lines === null ? (
        <p role="alert" className="whitespace-normal text-xs font-bold text-danger">Pratinjau tidak bisa dibuat: ada blok wajib yang hilang.</p>
      ) : (
        lines.map((l, i) => (
          <div
            key={i}
            className={`${ALIGN[l.align]} ${l.bold ? 'font-bold' : ''} whitespace-pre`}
            style={l.large ? { fontSize: '22px', lineHeight: 1.2, fontWeight: 700 } : undefined}
          >
            {l.text === '' ? ' ' : l.text}
          </div>
        ))
      )}
    </div>
  )
}
