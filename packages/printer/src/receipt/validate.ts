// Template validation shared with the Backoffice (the server runs the Go twin and returns its first issue;
// this returns all of them, in the same order, so issues[0] equals Go's).

import { LOCKED_TYPES, type ReceiptBlock } from './layout'
import { QR_URL_MAX } from './qr'
import { RASTER_MAX_HEIGHT, RASTER_MAX_WIDTH, decodeRaster, rasterByteLength } from './raster'

export const RECEIPT_LIMITS = {
  blocksMin: 3,
  blocksMax: 30,
  nameMax: 60,
  textMax: 500,
  textLinesMax: 12,
  totalTextMax: 1500,
  titleMax: 64,
  labelMax: 40,
  idMax: 64,
  templatesMax: 50,
  imageBlocksMax: 2,
  imageBytesMax: 11_520,
  qrBlocksMax: 2,
  urlMax: QR_URL_MAX,
  uploadBytesMax: 2 * 1024 * 1024,
} as const

export interface LayoutIssue {
  blockId?: string
  code: string
  message: string
}

const KNOWN_TYPES = ['header', 'transaction', 'items', 'totals', 'payment', 'points', 'text', 'divider', 'image', 'qr']
/** Fields only the built-in Standar layout (compat) may carry; a stored template never has them. */
const COMPAT_FIELDS: Record<string, string[]> = { '*': ['spaceBefore', 'spaceAfter'], payment: ['showChange'] }
const ALIGNS = ['left', 'center', 'right']
const SIZES = ['normal', 'large']
const STYLES = ['columns', 'inline']
const TX_FIELDS = ['orderNumber', 'date', 'cashier', 'customerName', 'customerPhone']
const PRINTABLE = /^[\x20-\x7e]*$/
const PRINTABLE_MULTILINE = /^[\x20-\x7e\n]*$/

const len = (s: string): number => [...s].length

/** All issues with a template body, template-level checks first, then each block in list order. */
export function validateTemplate(input: { name: string; paperWidth: number; blocks: readonly ReceiptBlock[] }): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const add = (code: string, message: string, blockId?: string): void => {
    issues.push(blockId === undefined ? { code, message } : { blockId, code, message })
  }
  const blocks = (input.blocks ?? []).map((b) => (b && typeof b === 'object' ? b : {})) as ReadonlyArray<Record<string, unknown> & { id?: string; type?: string }>

  // 1. name and paper width
  const nameLen = len(String(input.name ?? '').trim())
  if (nameLen < 1 || nameLen > RECEIPT_LIMITS.nameMax) add('name_invalid', `Nama template harus 1-${RECEIPT_LIMITS.nameMax} karakter.`)

  if (input.paperWidth !== 58 && input.paperWidth !== 80) add('paper_width_invalid', 'Lebar kertas harus 58mm atau 80mm.')

  // 2. block count
  if (blocks.length < RECEIPT_LIMITS.blocksMin) add('too_few_blocks', `Template minimal ${RECEIPT_LIMITS.blocksMin} blok.`)
  if (blocks.length > RECEIPT_LIMITS.blocksMax) add('too_many_blocks', `Template maksimal ${RECEIPT_LIMITS.blocksMax} blok.`)

  // 3. locked blocks: missing, disabled, order
  for (const t of LOCKED_TYPES) {
    if (!blocks.some((b) => b.type === t)) add('locked_missing', `Blok "${t}" wajib ada.`)
  }
  for (const b of blocks) {
    if ((LOCKED_TYPES as readonly string[]).includes(b.type ?? '') && b.enabled !== true) {
      add('locked_disabled', `Blok "${b.type}" tidak bisa dimatikan.`, b.id)
    }
  }
  const idx = LOCKED_TYPES.map((t) => blocks.findIndex((b) => b.type === t))
  const present = idx.filter((i) => i >= 0)
  if (present.some((v, i) => i > 0 && v < present[i - 1]!)) add('locked_order', 'Urutan blok wajib: Daftar barang, lalu Diskon & total, lalu Pembayaran.')
  for (const t of LOCKED_TYPES) {
    if (blocks.filter((b) => b.type === t).length > 1) add('locked_order', `Blok "${t}" hanya boleh ada satu.`)
  }

  // 4. total text
  const totalText = blocks.reduce((n, b) => n + (b.type === 'text' || b.type === 'header' ? len(String(b.text ?? '')) : 0), 0)
  if (totalText > RECEIPT_LIMITS.totalTextMax) add('total_text_too_long', `Total teks maksimal ${RECEIPT_LIMITS.totalTextMax} karakter.`)

  // 4b. image and QR counts
  const images = blocks.filter((b) => b.type === 'image')
  if (images.length > RECEIPT_LIMITS.imageBlocksMax) add('too_many_images', `Maksimal ${RECEIPT_LIMITS.imageBlocksMax} blok logo.`)
  const rasterBytes = images.reduce((n, b) => {
    const r = b.image as { width?: unknown; height?: unknown } | undefined
    const w = r?.width, h = r?.height
    // Only a usable geometry counts, exactly like the Go twin (rasterBytes returns 0 otherwise).
    return typeof w === 'number' && typeof h === 'number' && Number.isInteger(w) && Number.isInteger(h) && w >= 8 && w % 8 === 0 && h >= 1
      ? n + rasterByteLength({ width: w, height: h })
      : n
  }, 0)
  if (rasterBytes > RECEIPT_LIMITS.imageBytesMax) add('images_too_large', 'Ukuran logo terlalu besar.')
  if (blocks.filter((b) => b.type === 'qr').length > RECEIPT_LIMITS.qrBlocksMax) add('too_many_qr', `Maksimal ${RECEIPT_LIMITS.qrBlocksMax} blok QR.`)

  // 5. per block: type, text, label, image, url
  const seen = new Set<string>()
  for (const b of blocks) {
    const type = b.type ?? ''
    const id = typeof b.id === 'string' ? b.id : ''
    if (id === '' || len(id) > RECEIPT_LIMITS.idMax) add('bad_id', 'Setiap blok harus punya id 1-64 karakter.', b.id)
    else if (seen.has(id)) add('bad_id', 'Id blok harus unik.', b.id)
    seen.add(id)
    if (!KNOWN_TYPES.includes(type)) { add('unknown_type', `Jenis blok "${type}" tidak dikenal.`, b.id); continue }
    // image and url belong to their own blocks; stored anywhere else they would ride along in every pull.
    if ((type !== 'image' && b.image != null) || (type !== 'qr' && b.url != null)) add('stray_field', 'Kolom gambar atau alamat QR hanya untuk blok logo dan QR.', b.id)
    if (b.align !== undefined && !ALIGNS.includes(b.align as string)) add('bad_enum', 'Perataan tidak dikenal.', b.id)
    if (b.size !== undefined && !SIZES.includes(b.size as string)) add('bad_enum', 'Ukuran teks tidak dikenal.', b.id)
    if (b.style !== undefined && !STYLES.includes(b.style as string)) add('bad_enum', 'Gaya baris tidak dikenal.', b.id)
    if (Array.isArray(b.fields) && b.fields.some((f) => !TX_FIELDS.includes(f as string))) add('bad_enum', 'Kolom transaksi tidak dikenal.', b.id)
    for (const f of [...COMPAT_FIELDS['*']!, ...(COMPAT_FIELDS[type] ?? [])]) {
      if (f in b) add('compat_field', `Kolom "${f}" hanya untuk layout Standar.`, b.id)
    }
    if (type === 'header') {
      const t = String(b.text ?? '')
      if (len(t) > RECEIPT_LIMITS.titleMax) add('title_too_long', `Judul maksimal ${RECEIPT_LIMITS.titleMax} karakter.`, b.id)
      if (!PRINTABLE.test(t)) add('not_printable', 'Teks hanya boleh karakter ASCII yang bisa dicetak.', b.id)
    }
    if (type === 'text') {
      const t = String(b.text ?? '')
      if (len(t) > RECEIPT_LIMITS.textMax) add('text_too_long', `Teks maksimal ${RECEIPT_LIMITS.textMax} karakter.`, b.id)
      if (t.split('\n').length > RECEIPT_LIMITS.textLinesMax) add('too_many_lines', `Teks maksimal ${RECEIPT_LIMITS.textLinesMax} baris.`, b.id)
      if (!PRINTABLE_MULTILINE.test(t)) add('not_printable', 'Teks hanya boleh karakter ASCII yang bisa dicetak.', b.id)
      if (b.label !== undefined && len(String(b.label)) > RECEIPT_LIMITS.labelMax) add('label_too_long', `Label maksimal ${RECEIPT_LIMITS.labelMax} karakter.`, b.id)
    }
    if (type === 'image') {
      const r = b.image as { width?: unknown; height?: unknown } | null | undefined
      if (typeof r !== 'object' || r === null) add('image_invalid', 'Gambar logo tidak ada.', b.id)
      else if (typeof r.width === 'number' && r.width > RASTER_MAX_WIDTH) add('image_too_wide', `Lebar logo maksimal ${RASTER_MAX_WIDTH} titik.`, b.id)
      else if (typeof r.height === 'number' && r.height > RASTER_MAX_HEIGHT) add('image_too_tall', `Tinggi logo maksimal ${RASTER_MAX_HEIGHT} titik.`, b.id)
      else if (decodeRaster(r) === null) add('image_invalid', 'Gambar logo rusak.', b.id)
      if (b.label !== undefined && len(String(b.label)) > RECEIPT_LIMITS.labelMax) add('label_too_long', `Label maksimal ${RECEIPT_LIMITS.labelMax} karakter.`, b.id)
    }
    if (type === 'qr') {
      const u = typeof b.url === 'string' ? b.url : ''
      if (len(u) > RECEIPT_LIMITS.urlMax) add('url_too_long', `Alamat QR maksimal ${RECEIPT_LIMITS.urlMax} karakter.`, b.id)
      else if (!/^https?:\/\/[!-~]+$/.test(u)) add('url_invalid', 'Alamat QR harus diawali http:// atau https:// dan hanya berisi karakter ASCII.', b.id)
      if (b.label !== undefined && len(String(b.label)) > RECEIPT_LIMITS.labelMax) add('label_too_long', `Label maksimal ${RECEIPT_LIMITS.labelMax} karakter.`, b.id)
    }
  }
  return issues
}
