import { isAmbiguousFailure, isKeyConflict } from '../warehouses/stockWrite'

export const BATCH_KEY_CONFLICT_MESSAGE =
  'Sudah tercatat dengan isian sebelumnya; perubahan terbaru tidak dibuat. Tutup panel ini, muat ulang daftar kode, lalu periksa hasilnya.'

/** Appended when the outcome is unknown: the batch may exist even though no answer came. */
export const BATCH_AMBIGUOUS_HINT = ' Hasil belum pasti: tekan Generate lagi tanpa mengubah isian (jangan tutup lalu buka ulang) agar kode tidak dibuat dua kali.'

/** Message for a failed Buat Massal. A key conflict is never retried: the first attempt may have been applied. */
export function batchWriteError(e: unknown, fallback: string): string {
  if (isKeyConflict(e)) return BATCH_KEY_CONFLICT_MESSAGE
  const text = e instanceof Error && e.message ? e.message : fallback
  return isAmbiguousFailure(e) ? `${text.replace(/\.+$/, '')}.${BATCH_AMBIGUOUS_HINT}` : text
}

/**
 * The Idempotency-Key of one Buat Massal form open. `current()` mints on first use and then returns the same key, so
 * a retry from the same form (edits included) meets the server's claim; `drop()` runs when the form closes, so the
 * next open mints a new key.
 */
export function createBatchKeyHolder(mint: () => string) {
  let key: string | null = null
  return {
    current: (): string => (key ??= mint()),
    drop: (): void => {
      key = null
    },
  }
}
