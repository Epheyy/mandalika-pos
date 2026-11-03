import type { LabelMap } from './types'

export const LEDGER_KIND = {
  sale: { label: 'Penjualan', tone: 'neutral' },
  refund: { label: 'Refund', tone: 'neutral' },
  transfer_out: { label: 'Transfer Keluar', tone: 'neutral' },
  transfer_in: { label: 'Transfer Masuk', tone: 'neutral' },
  transfer_cancel: { label: 'Batal Transfer', tone: 'neutral' },
  receipt: { label: 'Penerimaan', tone: 'neutral' },
  adjust: { label: 'Penyesuaian', tone: 'neutral' },
  count: { label: 'Opname', tone: 'neutral' },
  opening: { label: 'Saldo Awal', tone: 'neutral' },
  write_off: { label: 'Penghapusan', tone: 'neutral' },
} as const satisfies LabelMap<string>

/** Pergerakan bucket columns; the hint is the column tooltip. */
export const LEDGER_BUCKET = {
  masuk: { label: 'Masuk', tone: 'neutral', hint: 'Barang masuk (pemasok), kiriman gudang ke toko, dan penggantian garansi' },
  penjualan: { label: 'Penjualan', tone: 'neutral', hint: 'Penjualan kasir' },
  refund: { label: 'Refund', tone: 'neutral', hint: 'Refund pelanggan yang dikembalikan ke stok' },
  transfer: { label: 'Transfer', tone: 'neutral', hint: 'Antar toko, toko ke gudang, dan barang yang dikirim keluar' },
  penyesuaian: { label: 'Penyesuaian', tone: 'neutral', hint: 'Penyesuaian, selisih opname, penghapusan, saldo awal yang diinput' },
  hadiah: { label: 'Hadiah', tone: 'neutral', hint: 'Barang hadiah per penjualan' },
} as const satisfies LabelMap<string>
