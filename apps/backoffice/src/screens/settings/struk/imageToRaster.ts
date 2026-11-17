import { RASTER_MAX_HEIGHT, RASTER_MAX_WIDTH, RECEIPT_LIMITS, ditherToRaster, type ReceiptRaster } from '@mandalika/printer/render'

export const UPLOAD_REFUSED = 'Gambar maks. 2 MB (PNG, JPG, WebP)'
export const UNREADABLE = 'Gambar tidak bisa dibaca; coba file lain.'
export const URL_FAILED = 'Logo tidak bisa diambil; unggah file gambarnya.'

const ACCEPTED_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']

export interface FitSize {
  /** Picture size in dots. */
  w: number
  h: number
  /** Canvas width: `w` rounded up to a multiple of 8 (the extra is white). */
  paddedW: number
}

/** Scales to fit 384 x 240 keeping the aspect ratio. A picture that already fits keeps its size (no upscaling). */
export function fitSize(width: number, height: number): FitSize {
  const scale = Math.min(1, RASTER_MAX_WIDTH / width, RASTER_MAX_HEIGHT / height)
  const w = Math.min(RASTER_MAX_WIDTH, Math.max(1, Math.round(width * scale)))
  const h = Math.min(RASTER_MAX_HEIGHT, Math.max(1, Math.round(height * scale)))
  return { w, h, paddedW: Math.ceil(w / 8) * 8 }
}

/** Decodes a picture, fits it, pads the width with white and dithers it to the template's 1-bit raster. */
async function blobToRaster(blob: Blob): Promise<ReceiptRaster> {
  const bitmap = await createImageBitmap(blob)
  try {
    const { w, h, paddedW } = fitSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = paddedW
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('canvas unavailable')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, paddedW, h)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, Math.floor((paddedW - w) / 2), 0, w, h)
    return ditherToRaster(ctx.getImageData(0, 0, paddedW, h).data, paddedW, h)
  } finally {
    bitmap.close()
  }
}

/** A picked file as a raster. Refuses other types and files over 2 MB before decoding. */
export async function fileToRaster(file: File): Promise<ReceiptRaster> {
  if (!ACCEPTED_TYPES.includes(file.type) || file.size > RECEIPT_LIMITS.uploadBytesMax) throw new Error(UPLOAD_REFUSED)
  try {
    return await blobToRaster(file)
  } catch {
    throw new Error(UNREADABLE)
  }
}

/** A picture from a URL (the brand logo) as a raster. A blocked or broken fetch asks for an upload instead. */
export async function urlToRaster(url: string): Promise<ReceiptRaster> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await blobToRaster(await res.blob())
  } catch {
    throw new Error(URL_FAILED)
  }
}
