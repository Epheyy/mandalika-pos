import type { ErpOutboxItem } from '@mandalika/api'
import type { LabelMap } from './types'

export const ERP_STATUS = {
  pending: { label: 'Menunggu', tone: 'neutral', hint: 'Menunggu giliran dikirim ke ERP.' },
  held: { label: 'Ditahan', tone: 'warn', hint: 'Ditahan karena ada yang perlu dicek dulu. Alasannya tertulis di kolom Alasan.' },
  sending: { label: 'Mengirim', tone: 'neutral', hint: 'Sedang dikirim ke ERP.' },
  delivered: { label: 'Terkirim', tone: 'ok', hint: 'ERP sudah menerima dokumen ini.' },
  replayed: { label: 'Diulang', tone: 'ok', hint: 'ERP sudah punya dokumen ini, jadi tidak tercatat dua kali.' },
  dead: { label: 'Gagal', tone: 'danger', hint: 'Gagal setelah beberapa kali percobaan. Cek penyebabnya, lalu kirim ulang.' },
} as const satisfies LabelMap<ErpOutboxItem['status']>

export const ERP_KIND = {
  sale: { label: 'Penjualan', tone: 'neutral' },
  refund: { label: 'Refund', tone: 'neutral' },
  transfer_out: { label: 'Transfer keluar', tone: 'neutral' },
  transfer_in: { label: 'Transfer masuk', tone: 'neutral' },
  transfer_cancel: { label: 'Batal transfer', tone: 'neutral' },
  receipt: { label: 'Barang Masuk', tone: 'neutral' },
  adjust: { label: 'Penyesuaian', tone: 'neutral' },
  count: { label: 'Stok opname', tone: 'neutral' },
  opening: { label: 'Saldo awal', tone: 'neutral' },
  write_off: { label: 'Penghapusan', tone: 'neutral' },
  void: { label: 'Pembatalan', tone: 'neutral' },
} as const satisfies LabelMap<ErpOutboxItem['kind']>
