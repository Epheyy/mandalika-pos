import type { MovementLedgerSummaryRow } from '@mandalika/api'

type MovementBuckets = MovementLedgerSummaryRow['buckets']

/** The bucket columns of Pergerakan, in display order. The keys are the API's bucket names. */
export const BUCKET_COLUMNS: ReadonlyArray<{ key: keyof MovementBuckets; label: string; hint: string }> = [
  { key: 'masuk', label: 'Masuk', hint: 'Barang masuk (pemasok), kiriman gudang ke toko, dan penggantian garansi' },
  { key: 'penjualan', label: 'Penjualan', hint: 'Penjualan kasir' },
  { key: 'refund', label: 'Refund', hint: 'Refund pelanggan yang dikembalikan ke stok' },
  { key: 'transfer', label: 'Transfer', hint: 'Antar toko, toko ke gudang, dan barang yang dikirim keluar' },
  { key: 'penyesuaian', label: 'Penyesuaian', hint: 'Penyesuaian, selisih opname, penghapusan, saldo awal yang diinput' },
  { key: 'hadiah', label: 'Hadiah', hint: 'Barang hadiah per penjualan' },
]

/** A signed quantity as shown in the table: +5, -3, 0. */
export function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

/** Saldo Awal + all six buckets = Saldo Akhir. */
export function bucketsReconcile(r: Pick<MovementLedgerSummaryRow, 'opening' | 'closing' | 'buckets'>): boolean {
  const sum = BUCKET_COLUMNS.reduce((acc, c) => acc + r.buckets[c.key], 0)
  return r.opening + sum === r.closing
}
