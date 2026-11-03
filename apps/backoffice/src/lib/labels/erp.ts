import type { ErpOutboxItem } from '@mandalika/api'
import type { LabelMap } from './types'

export const ERP_STATUS = {
  pending: { label: 'Menunggu', tone: 'neutral' },
  held: { label: 'Ditahan', tone: 'warn' },
  sending: { label: 'Mengirim', tone: 'neutral' },
  delivered: { label: 'Terkirim', tone: 'ok' },
  replayed: { label: 'Diulang', tone: 'ok' },
  dead: { label: 'Gagal', tone: 'danger' },
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
} as const satisfies LabelMap<ErpOutboxItem['kind']>
