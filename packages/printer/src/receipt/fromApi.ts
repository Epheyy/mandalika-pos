// Turns the template the sync pull ships (`SyncPullBundle.receiptTemplate`) into a ReceiptLayout.
//
// The tablet is the last line of defence: a newer Backoffice may send block types this build does not know,
// and a hand-edited row may break a rule the server enforces. So this is tolerant about blocks (it drops
// what it cannot read) and strict about the locked ones: a template without a usable items, totals and
// payment block in order is refused, and the caller prints Standar instead.

import type { PaperWidth, ReceiptBlock, ReceiptLayout, TxField } from './layout'
import { isPrintableQrUrl } from './qr'
import { decodeRaster } from './raster'
import { validateTemplate } from './validate'

const TX_FIELDS: readonly TxField[] = ['orderNumber', 'date', 'cashier', 'customerName', 'customerPhone']
const LOCKED_CODES = ['locked_missing', 'locked_disabled', 'locked_order']

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads an optional field: `absent` when undefined, `bad` (a symbol-like marker) when it has the wrong type. */
const BAD = Symbol('bad')
type Read<T> = T | typeof BAD | undefined

function bool(v: unknown): Read<boolean> { return v === undefined ? undefined : typeof v === 'boolean' ? v : BAD }
function str(v: unknown): Read<string> { return v === undefined ? undefined : typeof v === 'string' ? v : BAD }
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): Read<T> {
  return v === undefined ? undefined : typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : BAD
}
function fields(v: unknown): Read<TxField[]> {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.some((f) => !TX_FIELDS.includes(f as TxField))) return BAD
  return v as TxField[]
}
const anyBad = (...vs: unknown[]): boolean => vs.some((v) => v === BAD)
const or = <T>(v: Read<T>, d: T): T => (v === undefined || v === BAD ? d : v)

function readBlock(b: unknown): ReceiptBlock | null {
  if (!isObj(b) || typeof b.id !== 'string' || typeof b.type !== 'string' || typeof b.enabled !== 'boolean') return null
  const id = b.id
  switch (b.type) {
    case 'header': {
      const text = str(b.text); const size = oneOf(b.size, ['normal', 'large'] as const)
      const n = bool(b.showOutletName); const a = bool(b.showOutletAddress); const p = bool(b.showOutletPhone)
      if (anyBad(text, size, n, a, p)) return null
      return { id, type: 'header', enabled: b.enabled, text: or(text, ''), size: or(size, 'normal'),
        showOutletName: or(n, false), showOutletAddress: or(a, false), showOutletPhone: or(p, false) }
    }
    case 'transaction': {
      const f = fields(b.fields); const style = oneOf(b.style, ['columns', 'inline'] as const)
      if (anyBad(f, style)) return null
      return { id, type: 'transaction', enabled: b.enabled, fields: or(f, []), style: or(style, 'columns') }
    }
    case 'items':
      return b.enabled ? { id, type: 'items', enabled: true } : null
    case 'totals': {
      const s = bool(b.showSubtotal); const d = bool(b.showDiscount); const t = bool(b.showTax)
      if (!b.enabled || anyBad(s, d, t)) return null
      return { id, type: 'totals', enabled: true, showSubtotal: or(s, true), showDiscount: or(d, true), showTax: or(t, true) }
    }
    case 'payment':
      return b.enabled ? { id, type: 'payment', enabled: true } : null
    case 'points':
      return { id, type: 'points', enabled: b.enabled }
    case 'text': {
      const text = str(b.text); const label = str(b.label); const bold = bool(b.bold)
      const align = oneOf(b.align, ['left', 'center', 'right'] as const); const size = oneOf(b.size, ['normal', 'large'] as const)
      if (anyBad(text, label, bold, align, size)) return null
      return {
        id, type: 'text', enabled: b.enabled, ...(typeof label === 'string' ? { label } : {}), text: or(text, ''),
        align: or(align, 'left'), bold: or(bold, false), size: or(size, 'normal'),
      }
    }
    case 'divider':
      return { id, type: 'divider', enabled: b.enabled }
    case 'image': {
      const label = str(b.label); const align = oneOf(b.align, ['left', 'center', 'right'] as const)
      if (anyBad(label, align) || decodeRaster(b.image) === null) return null
      return {
        id, type: 'image', enabled: b.enabled, ...(typeof label === 'string' ? { label } : {}),
        image: b.image as { width: number; height: number; data: string }, align: or(align, 'center'),
      }
    }
    case 'qr': {
      const label = str(b.label); const align = oneOf(b.align, ['left', 'center', 'right'] as const)
      if (anyBad(label, align) || !isPrintableQrUrl(b.url)) return null
      return { id, type: 'qr', enabled: b.enabled, ...(typeof label === 'string' ? { label } : {}), url: b.url, align: or(align, 'center') }
    }
    default:
      return null // a block type a newer Backoffice added
  }
}

/** The layout for a pulled template, or null when it cannot be trusted (the caller then prints Standar).
 *  Drops unknown block types and blocks with ill-typed fields. Never returns `compat`. */
export function layoutFromApi(t: unknown): ReceiptLayout | null {
  if (!isObj(t)) return null
  const width = t.paperWidth
  if (width !== 58 && width !== 80) return null
  if (!Array.isArray(t.blocks)) return null
  const blocks: ReceiptBlock[] = []
  for (const raw of t.blocks) {
    const b = readBlock(raw)
    if (b) blocks.push(b)
  }
  const issues = validateTemplate({ name: 'template', paperWidth: width, blocks })
  if (issues.some((i) => LOCKED_CODES.includes(i.code))) return null
  return { paperWidth: width as PaperWidth, blocks }
}
