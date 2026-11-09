import type { IngredientStockCount } from '@mandalika/api'
import type { ConfirmOptions } from '../../ui/ConfirmDialog'

/** Start only lists the ingredients to count: no quantity is frozen (the server writes the counted quantity over live stock on completion). */
export function startIngredientCountConfirm(name: string): ConfirmOptions {
  return {
    title: `Mulai opname ${name}?`,
    consequence: 'Daftar bahan di lokasi ini diambil untuk dihitung. Stok tidak berubah sampai opname diselesaikan.',
    confirmLabel: 'Mulai opname',
  }
}

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

/** The leave question while ingredient rows are typed but not saved (leaving drops them). Danger tone starts focus on "Lanjut edit". */
export function leaveUnsavedCountConfirm(rows: number): ConfirmOptions {
  return {
    title: 'Tinggalkan hitungan?',
    consequence: `${rows} bahan punya jumlah yang belum disimpan. Kalau pindah sekarang, jumlah itu hilang.`,
    confirmLabel: 'Tinggalkan dan buang',
    cancelLabel: 'Lanjut edit',
    tone: 'danger',
  }
}
