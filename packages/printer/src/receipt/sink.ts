// Output targets for the receipt renderer: ESC/POS bytes for the printer, text lines for the preview.

import { RASTER_BAND_ROWS, decodeRaster, type ReceiptRaster } from './raster'
import { qrBytes } from './qr'
import { encodeLegacy } from './text'

export type Align = 'left' | 'center' | 'right'

export type Cmd =
  | 'init'
  | 'alignLeft' | 'alignCenter' | 'alignRight'
  | 'boldOn' | 'boldOff'
  | 'largeOn' | 'largeOff'
  | 'feed3' | 'cut'

export interface ReceiptSink {
  cmd(c: Cmd): void
  line(text?: string): void
  /** A raster image (`GS v 0`). A malformed raster prints nothing. */
  image(r: ReceiptRaster): void
  /** A QR code (`GS ( k`). */
  qr(data: string, moduleSize: number): void
}

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

const CMD_BYTES: Readonly<Record<Cmd, readonly number[]>> = {
  init: [ESC, 0x40],
  alignLeft: [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  alignRight: [ESC, 0x61, 0x02],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  largeOn: [GS, 0x21, 0x11], // double width + height
  largeOff: [GS, 0x21, 0x00],
  feed3: [ESC, 0x64, 0x03],
  cut: [GS, 0x56, 0x42, 0x00], // partial cut (ignored if unsupported)
}

/** Writes ESC/POS. A pure byte map: it never normalises text (the renderer already has). */
export class EscPosSink implements ReceiptSink {
  private parts: number[] = []
  cmd(c: Cmd): void {
    this.parts.push(...CMD_BYTES[c])
  }
  line(text = ''): void {
    this.parts.push(...encodeLegacy(text), LF)
  }
  image(r: ReceiptRaster): void {
    const bytes = decodeRaster(r)
    if (!bytes) return
    const rowBytes = r.width / 8
    for (let y = 0; y < r.height; y += RASTER_BAND_ROWS) {
      const rows = Math.min(RASTER_BAND_ROWS, r.height - y)
      this.parts.push(GS, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8)
      for (let i = y * rowBytes; i < (y + rows) * rowBytes; i++) this.parts.push(bytes[i]!)
    }
  }
  qr(data: string, moduleSize: number): void {
    this.parts.push(...qrBytes(data, moduleSize))
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

export type PreviewLine =
  | { kind: 'text'; text: string; align: Align; bold: boolean; large: boolean }
  | { kind: 'image'; raster: ReceiptRaster; align: Align }
  | { kind: 'qr'; data: string; align: Align }

/** Collects what the printer would print. Text is mapped like the bytes are, then split at the printer's own
 *  wrap width (`cols`, or `cols / 2` for large text), so a preview line is never wider than the paper. */
export class PreviewSink implements ReceiptSink {
  private lines: PreviewLine[] = []
  private align: Align = 'left'
  private bold = false
  private large = false
  constructor(private readonly cols: number) {}

  cmd(c: Cmd): void {
    switch (c) {
      case 'init': this.align = 'left'; this.bold = false; this.large = false; break
      case 'alignLeft': this.align = 'left'; break
      case 'alignCenter': this.align = 'center'; break
      case 'alignRight': this.align = 'right'; break
      case 'boldOn': this.bold = true; break
      case 'boldOff': this.bold = false; break
      case 'largeOn': this.large = true; break
      case 'largeOff': this.large = false; break
      default: break // feed3 / cut have no preview
    }
  }

  line(text = ''): void {
    const printed = String.fromCharCode(...encodeLegacy(text))
    const width = Math.max(1, this.large ? Math.floor(this.cols / 2) : this.cols)
    const state = { align: this.align, bold: this.bold, large: this.large }
    if (printed.length === 0) { this.lines.push({ kind: 'text', text: '', ...state }); return }
    for (let i = 0; i < printed.length; i += width) {
      this.lines.push({ kind: 'text', text: printed.slice(i, i + width), ...state })
    }
  }

  image(r: ReceiptRaster): void {
    if (decodeRaster(r)) this.lines.push({ kind: 'image', raster: r, align: this.align })
  }

  qr(data: string): void {
    this.lines.push({ kind: 'qr', data, align: this.align })
  }

  done(): PreviewLine[] {
    return this.lines.slice()
  }
}
