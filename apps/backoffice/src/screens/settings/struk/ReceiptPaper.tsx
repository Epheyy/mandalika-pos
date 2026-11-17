import { COLS_BY_WIDTH, SAMPLE_RECEIPT, receiptPreview, type PreviewLine, type ReceiptLayout } from '@mandalika/printer/render'
import { rasterToBmpDataUrl } from './rasterPreview'

/** The preview lines for a layout, or null when the renderer refuses it (a template with a missing locked block).
 *  `graphics: false` is the tablet's `Cetak logo & QR` switch off: no logo, and the QR as its address in text. */
export function previewLines(layout: ReceiptLayout, graphics = true): PreviewLine[] | null {
  try {
    return receiptPreview(layout, SAMPLE_RECEIPT, { graphics })
  } catch {
    return null
  }
}

interface ReceiptPaperProps {
  layout: ReceiptLayout
  /** Draw the logo and QR (default). Off shows what a tablet with `Cetak logo & QR` off prints. */
  graphics?: boolean
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const
/** Printable dots across the paper; a logo is drawn at its share of this. */
const DOTS_BY_WIDTH = { 58: 384, 80: 576 } as const

/** The slip as the tablet prints it: the same renderer, drawn as monospace lines `cols` characters wide.
 *  Large lines take two columns per character, so they are drawn at double size. A logo is its dithered raster; a QR
 *  is a placeholder box with its address, since no QR library ships with the Backoffice. */
export function ReceiptPaper({ layout, graphics = true }: ReceiptPaperProps) {
  const lines = previewLines(layout, graphics)
  const cols = COLS_BY_WIDTH[layout.paperWidth]
  const dots = DOTS_BY_WIDTH[layout.paperWidth]
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
        lines.map((l, i) => <PaperLine key={i} line={l} dots={dots} />)
      )}
    </div>
  )
}

function PaperLine({ line: l, dots }: { line: PreviewLine; dots: number }) {
  if (l.kind === 'image') {
    const src = rasterToBmpDataUrl(l.raster)
    return (
      <div data-testid="preview-image" className={`${ALIGN[l.align]} my-1`}>
        {src && (
          <img
            src={src} alt="Logo" draggable={false}
            style={{ display: 'inline-block', width: `${(l.raster.width / dots) * 100}%`, imageRendering: 'pixelated' }}
          />
        )}
      </div>
    )
  }
  if (l.kind === 'qr') {
    return (
      <div data-testid="preview-qr" className={`${ALIGN[l.align]} my-1`}>
        <div
          aria-hidden="true"
          className="inline-flex h-16 w-16 items-center justify-center border-2 border-[#111] text-sm font-bold tracking-widest"
        >
          QR
        </div>
        <div className="whitespace-normal break-all text-[9px] leading-tight">{l.data}</div>
      </div>
    )
  }
  return (
    <div
      className={`${ALIGN[l.align]} ${l.bold ? 'font-bold' : ''} whitespace-pre`}
      style={l.large ? { fontSize: '22px', lineHeight: 1.2, fontWeight: 700 } : undefined}
    >
      {l.text === '' ? ' ' : l.text}
    </div>
  )
}
