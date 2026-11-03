import type { IngredientStockCount } from '@mandalika/api'
import type { ConfirmOptions } from '../../ui/ConfirmDialog'
import { cancelCountConfirm, startCountConfirm } from '../stockcount/countConfirm'

/** Start has the same words for ingredients and products. */
export const startIngredientCountConfirm = startCountConfirm
export const cancelIngredientCountConfirm = cancelCountConfirm

export interface IngredientCountSummary {
  total: number
  /** Lines with a saved counted quantity; only these replace stock when the count completes. */
  counted: number
  uncounted: number
}

export function summarizeIngredientCount(items: ReadonlyArray<Pick<NonNullable<IngredientStockCount['items']>[number], 'counted'>>): IngredientCountSummary {
  const counted = items.filter((it) => it.counted != null).length
  return { total: items.length, counted, uncounted: items.length - counted }
}

/** Completing replaces the stock of every counted ingredient with the counted quantity; the server skips lines with no count. */
export function completeIngredientCountConfirm(name: string, location: string, s: IngredientCountSummary): ConfirmOptions {
  const effect =
    s.counted === 0
      ? `Belum ada bahan yang dihitung, jadi stok di ${location} tidak berubah.`
      : `Stok ${s.counted} bahan di ${location} diganti dengan jumlah yang dihitung.${s.uncounted > 0 ? ` ${s.uncounted} bahan yang belum dihitung tidak diubah.` : ''}`
  return {
    title: `Selesaikan opname ${name}?`,
    consequence: effect,
    confirmLabel: 'Selesaikan opname',
  }
}

/** Unsaved quantities are not part of the count the server completes. */
export const UNSAVED_COUNT_MESSAGE = 'Ada jumlah yang belum disimpan. Klik Simpan dulu, lalu selesaikan opname.'
