// Template validation shared with the Backoffice (the server runs the Go twin and returns its first issue;
// this returns all of them, in the same order, so issues[0] equals Go's).

import { LOCKED_TYPES, type ReceiptBlock } from './layout'

export const RECEIPT_LIMITS = {
  blocksMin: 3,
  blocksMax: 30,
  nameMax: 60,
  textMax: 500,
  textLinesMax: 12,
  totalTextMax: 1500,
  titleMax: 64,
  labelMax: 40,
  templatesMax: 50,
  imageBlocksMax: 2,
  imageBytesMax: 11_520,
  qrBlocksMax: 2,
  urlMax: 300,
  uploadBytesMax: 2 * 1024 * 1024,
} as const

export interface LayoutIssue {
  blockId?: string
  code: string
  message: string
}

const KNOWN_TYPES = ['header', 'transaction', 'items', 'totals', 'payment', 'points', 'text', 'divider']
/** Fields only the built-in Standar layout (compat) may carry; a stored template never has them. */
const COMPAT_FIELDS: Record<string, string[]> = { '*': ['spaceBefore', 'spaceAfter'], payment: ['showChange'] }
const PRINTABLE = /^[\x20-\x7e]*$/
const PRINTABLE_MULTILINE = /^[\x20-\x7e\n]*$/

const len = (s: string): number => [...s].length

/** All issues with a template body, template-level checks first, then each block in list order. */
export function validateTemplate(input: { name: string; paperWidth: number; blocks: readonly ReceiptBlock[] }): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const add = (code: string, message: string, blockId?: string): void => {
    issues.push(blockId === undefined ? { code, message } : { blockId, code, message })
  }
  const blocks = input.blocks as ReadonlyArray<Record<string, unknown> & { id?: string; type?: string }>

  // 1. name
  const nameLen = len(input.name.trim())
  if (nameLen < 1 || nameLen > RECEIPT_LIMITS.nameMax) add('name_invalid', `Nama template harus 1-${RECEIPT_LIMITS.nameMax} karakter.`)

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

  // 5. per block: type, text, label, (url, image: Phase 4)
  for (const b of blocks) {
    const type = b.type ?? ''
    if (!KNOWN_TYPES.includes(type)) { add('unknown_type', `Jenis blok "${type}" tidak dikenal.`, b.id); continue }
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
  }
  return issues
}
