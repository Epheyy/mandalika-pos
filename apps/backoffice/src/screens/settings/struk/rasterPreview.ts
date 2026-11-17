import type { ReceiptRaster } from '@mandalika/printer/render'

/** A 1-bit raster as a BMP data URL (black dots on white), so an `<img>` can show exactly what the printer prints
 *  without a canvas. Null when the raster is malformed. */
export function rasterToBmpDataUrl(r: ReceiptRaster): string | null {
  let bin: string
  try { bin = atob(r.data) } catch { return null }
  const rowBytes = r.width / 8
  if (!Number.isInteger(rowBytes) || rowBytes < 1 || bin.length !== rowBytes * r.height) return null
  const stride = Math.ceil(rowBytes / 4) * 4
  const pixelOffset = 14 + 40 + 8
  const out = new Uint8Array(pixelOffset + stride * r.height)
  const view = new DataView(out.buffer)
  out[0] = 0x42; out[1] = 0x4d
  view.setUint32(2, out.length, true)
  view.setUint32(10, pixelOffset, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, r.width, true)
  view.setInt32(22, r.height, true) // positive: rows are stored bottom to top
  view.setUint16(26, 1, true)
  view.setUint16(28, 1, true)
  view.setUint32(46, 2, true)
  // palette: index 0 white, index 1 black (a set bit is a black dot)
  out.set([255, 255, 255, 0, 0, 0, 0, 0], 54)
  for (let y = 0; y < r.height; y++) {
    const dst = pixelOffset + (r.height - 1 - y) * stride
    for (let x = 0; x < rowBytes; x++) out[dst + x] = bin.charCodeAt(y * rowBytes + x)
  }
  let s = ''
  for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]!)
  return `data:image/bmp;base64,${btoa(s)}`
}
