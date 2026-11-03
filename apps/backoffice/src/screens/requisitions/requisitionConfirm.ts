import type { ConfirmOptions } from '../../ui/ConfirmDialog'

/** The requisition actions that ask first. None of them moves stock: stock moves when the resulting transfer is sent. */
export type RequisitionAction = 'submit' | 'cancel' | 'fulfil' | 'approve'

interface RequisitionConfirmInput {
  number: string
  /** Approve only: units approved across all lines, and the source warehouse's name. */
  approvedUnits?: number
  warehouseName?: string
  /** Fulfil only: the linked transfer was cancelled, so this makes a new draft. */
  refulfil?: boolean
}

const units = (n: number) => `${n.toLocaleString('id-ID')} unit`

/** Question, consequence and button words for a requisition action. */
export function requisitionConfirm(action: RequisitionAction, i: RequisitionConfirmInput): ConfirmOptions {
  switch (action) {
    case 'submit':
      return {
        title: `Ajukan permintaan ${i.number}?`,
        consequence: 'Permintaan dikirim ke gudang untuk disetujui dan tidak bisa diubah lagi.',
        confirmLabel: 'Ajukan permintaan',
      }
    case 'cancel':
      return {
        title: `Batalkan permintaan ${i.number}?`,
        consequence: 'Permintaan dibatalkan dan tidak diproses gudang. Stok tidak berubah.',
        confirmLabel: 'Batalkan permintaan',
        cancelLabel: 'Kembali',
        tone: 'danger',
      }
    case 'fulfil':
      return {
        title: `${i.refulfil ? 'Buat transfer ulang' : 'Buat transfer'} untuk ${i.number}?`,
        consequence: 'Draf transfer dibuat dari qty yang disetujui. Stok baru berpindah saat transfer dikirim.',
        confirmLabel: i.refulfil ? 'Buat transfer ulang' : 'Buat transfer',
      }
    case 'approve':
      return {
        title: `Setujui permintaan ${i.number}?`,
        consequence: `${units(i.approvedUnits ?? 0)} disiapkan dari ${i.warehouseName ?? 'gudang terpilih'}. Stok baru berpindah saat transfer dikirim.`,
        confirmLabel: 'Setujui permintaan',
      }
  }
}
