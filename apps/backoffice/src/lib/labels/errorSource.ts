import type { LabelMap } from './types'

export const ERROR_SOURCE = {
  sync: { label: 'Sync', tone: 'warn' },
  runtime: { label: 'Runtime', tone: 'danger' },
  print: { label: 'Cetak', tone: 'neutral' },
  backend: { label: 'Backend', tone: 'info' },
} as const satisfies LabelMap<string>

/** What the POS and backend tag an error with (`kind`). Sync failures use the outbox type. Anything not listed reads "Lainnya" with the code as the hint. */
export const ERROR_KIND = {
  order: { label: 'Penjualan', tone: 'neutral' },
  refund: { label: 'Refund', tone: 'neutral' },
  shift_open: { label: 'Buka shift', tone: 'neutral' },
  shift_close: { label: 'Tutup shift', tone: 'neutral' },
  cash_flow: { label: 'Kas masuk/keluar', tone: 'neutral' },
  customer_create: { label: 'Pelanggan baru', tone: 'neutral' },
  transfer_receive: { label: 'Terima transfer', tone: 'neutral' },
  outbox_corrupt: { label: 'Antrean tablet rusak', tone: 'danger' },
  journal_fallback: { label: 'Jurnal tablet beralih', tone: 'warn' },
  requisition_storage: { label: 'Permintaan barang tak tersimpan', tone: 'warn' },
  panic: { label: 'Error server', tone: 'danger' },
  uncaught: { label: 'Error aplikasi', tone: 'danger' },
  unhandledrejection: { label: 'Error aplikasi', tone: 'danger' },
  order_seq_write: { label: 'Nomor struk gagal disimpan', tone: 'warn' },
  sale_line_data: { label: 'Data baris refund', tone: 'warn' },
  outbox_write: { label: 'Transaksi gagal disimpan di tablet', tone: 'danger' },
  receipt: { label: 'Cetak struk', tone: 'neutral' },
  tanda_terima: { label: 'Cetak tanda terima', tone: 'neutral' },
} as const satisfies LabelMap<string>
