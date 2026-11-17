// 1-bit raster images for the receipt logo. Pure: no canvas, no Capacitor, so the Backoffice and the tests
// share it with the printer. The Backoffice decodes the picture and calls `ditherToRaster`; the tablet only
// ever reads the stored result.

export interface ReceiptRaster {
  /** Dots; a multiple of 8. */
  width: number
  /** Dots (rows). */
  height: number
  /** Base64 of `width / 8 * height` bytes: rows top to bottom, MSB first, 1 = black. */
  data: string
}

export const RASTER_MAX_WIDTH = 384
export const RASTER_MAX_HEIGHT = 240
/** Largest raster a template may carry (384 x 240 dots, packed). */
export const RASTER_MAX_BYTES = (RASTER_MAX_WIDTH / 8) * RASTER_MAX_HEIGHT

/** Rows per `GS v 0` command. Some printers drop or garble a tall image; Task 4.5 tries 24 if 64 misbehaves. */
export const RASTER_BAND_ROWS = 64

/** Bytes a raster must decode to. */
export const rasterByteLength = (r: { width: number; height: number }): number => (r.width / 8) * r.height

const B64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The packed bytes of a raster, or null when it is malformed (wrong size, bad base64, bad geometry). Never throws. */
export function decodeRaster(r: unknown): Uint8Array | null {
  if (typeof r !== 'object' || r === null) return null
  const { width, height, data } = r as Partial<ReceiptRaster>
  if (typeof width !== 'number' || typeof height !== 'number' || typeof data !== 'string') return null
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  if (width < 8 || width % 8 !== 0 || width > RASTER_MAX_WIDTH) return null
  if (height < 1 || height > RASTER_MAX_HEIGHT) return null
  if (data.length % 4 !== 0 || !B64.test(data)) return null
  let bin: string
  try { bin = atob(data) } catch { return null }
  if (bin.length !== rasterByteLength({ width, height }) || btoa(bin) !== data) return null
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

/** Floyd-Steinberg dither of an RGBA image to a packed 1-bit raster (threshold 128). Alpha is composited over
 *  white and luminance is 0.299R + 0.587G + 0.114B. `width` must be a multiple of 8: the caller pads with white. */
export function ditherToRaster(rgba: Uint8ClampedArray, width: number, height: number): ReceiptRaster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || width % 8 !== 0 || height < 1) {
    throw new Error('raster width must be a multiple of 8 and height at least 1')
  }
  if (rgba.length < width * height * 4) throw new Error('image data is shorter than width x height')
  const lum = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3]! / 255
    const r = rgba[i * 4]! * a + 255 * (1 - a)
    const g = rgba[i * 4 + 1]! * a + 255 * (1 - a)
    const b = rgba[i * 4 + 2]! * a + 255 * (1 - a)
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  const rowBytes = width / 8
  const packed = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const old = lum[i]!
      const black = old < 128
      if (black) packed[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7)
      const err = old - (black ? 0 : 255)
      if (x + 1 < width) lum[i + 1]! += (err * 7) / 16
      if (y + 1 < height) {
        if (x > 0) lum[i + width - 1]! += (err * 3) / 16
        lum[i + width]! += (err * 5) / 16
        if (x + 1 < width) lum[i + width + 1]! += err / 16
      }
    }
  }
  return { width, height, data: toBase64(packed) }
}
