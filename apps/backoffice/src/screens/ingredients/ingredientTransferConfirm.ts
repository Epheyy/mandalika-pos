import type { IngredientTransfer } from '@mandalika/api'
import type { ConfirmOptions } from '../../ui/ConfirmDialog'

type TransferCopyInput = Pick<IngredientTransfer, 'transferNo' | 'status' | 'items' | 'source'>

const sourceName = (t: TransferCopyInput) => t.source.name ?? 'sumber'
const kinds = (t: TransferCopyInput) => `${t.items.length.toLocaleString('id-ID')} jenis bahan`

/** Kirim takes the sent quantities out of the source now (verified in write/ingredient_transfer.go). */
export function sendIngredientTransferConfirm(t: TransferCopyInput): ConfirmOptions {
  return {
    title: `Kirim transfer ${t.transferNo}?`,
    consequence: `Stok ${kinds(t)} akan keluar dari ${sourceName(t)} sekarang.`,
    confirmLabel: 'Kirim transfer',
  }
}

/** Batalkan returns the stock of a sent transfer to the source; a draft moved none. The reason is asked in the dialog. */
export function cancelIngredientTransferConfirm(t: TransferCopyInput): ConfirmOptions {
  return {
    title: `Batalkan transfer ${t.transferNo}?`,
    consequence:
      t.status === 'in_transit'
        ? `Stok ${kinds(t)} dikembalikan ke ${sourceName(t)} sekarang.`
        : 'Draf transfer dibatalkan. Stok tidak berubah.',
    confirmLabel: 'Batalkan transfer',
    cancelLabel: 'Kembali',
    tone: 'danger',
    input: { label: 'Alasan pembatalan', multiline: true, maxLength: 200 },
  }
}

/** The server needs a reason; an empty answer reads "Dibatalkan", as the old prompt did. */
export const cancelReason = (value: string | undefined): string => value?.trim() || 'Dibatalkan'
