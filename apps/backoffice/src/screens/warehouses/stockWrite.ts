import { ApiError, type GoodsReceiptInput, type WarehouseStockRow } from '@mandalika/api'
import { unitCostError, wholeQtyError } from '../../lib/inputRules'

/** What the server says when an Idempotency-Key was already used for another operation (409). */
export const KEY_CONFLICT_PREFIX = 'kunci idempotensi'

export const KEY_CONFLICT_MESSAGE =
  'Sudah tercatat dengan isian sebelumnya; perubahan terbaru tidak disimpan. Tutup panel ini dan muat ulang untuk melihat hasilnya.'

/** Appended when the outcome is unknown: the write may have been applied even though no answer came. */
export const AMBIGUOUS_HINT = ' Hasil belum pasti: tekan simpan lagi di panel ini (jangan tutup lalu buka ulang) agar tidak tercatat dua kali.'

/** True for the key-reuse 409 only. Other 409s (approval required, lock busy, stock guard) mean something else. */
export function isKeyConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.message.toLowerCase().startsWith(KEY_CONFLICT_PREFIX)
}

/** No answer, or a server error: the write may or may not have been applied. */
export function isAmbiguousFailure(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status >= 500)
}

/** Message for a failed stock write. A key conflict is never retried: the first attempt may have been applied. */
export function stockWriteError(e: unknown, fallback: string): string {
  if (isKeyConflict(e)) return KEY_CONFLICT_MESSAGE
  const text = e instanceof Error && e.message ? e.message : fallback
  return isAmbiguousFailure(e) ? `${text}.${AMBIGUOUS_HINT}`.replace(/\.\./g, '.') : text
}

/** One editable goods-in line: the raw text of the two inputs. */
export interface GoodsLine {
  qty: string
  unitCost: string
}

export const goodsLineKey = (productId: string, variantSize: string): string => `${productId}|${variantSize}`

/** Only the lines with a quantity above zero go out; the unit cost is optional and informational. */
export function goodsReceiptItems(
  rows: readonly WarehouseStockRow[],
  lines: Readonly<Record<string, GoodsLine>>,
): GoodsReceiptInput['items'] {
  const items: GoodsReceiptInput['items'] = []
  for (const r of rows) {
    const l = lines[goodsLineKey(r.productId, r.variantSize)]
    const qty = Number(l?.qty ?? '')
    if (!qty || qty <= 0) continue
    items.push({
      productId: r.productId,
      variantSize: r.variantSize,
      qty,
      unitCost: l?.unitCost?.trim() ? Number(l.unitCost) : null,
    })
  }
  return items
}

/** Field messages of one goods-in line: shown next to the quantity / unit cost input. */
export interface GoodsLineErrors {
  qty: string | null
  unitCost: string | null
}

/** Per-line field errors (lines with none are left out). A cost typed on a line without quantity is still checked. */
export function goodsLineErrors(
  rows: readonly WarehouseStockRow[],
  lines: Readonly<Record<string, GoodsLine>>,
): Record<string, GoodsLineErrors> {
  const out: Record<string, GoodsLineErrors> = {}
  for (const r of rows) {
    const key = goodsLineKey(r.productId, r.variantSize)
    const l = lines[key]
    if (!l) continue
    const e = { qty: wholeQtyError(l.qty), unitCost: unitCostError(l.unitCost) }
    if (e.qty || e.unitCost) out[key] = e
  }
  return out
}

/** "Stok sekarang 9 → baru 7 (−2)"; null while the new quantity is not a usable number. */
export function stockChangeLine(current: number, next: number | null): string | null {
  if (next === null) return null
  const delta = next - current
  const shown = delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '0'
  return `Stok sekarang ${current} → baru ${next} (${shown})`
}
