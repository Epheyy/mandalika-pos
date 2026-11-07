import { ApiError, type Transfer } from '@mandalika/api'

/** The two stock-moving actions of a transfer that ask first. */
export type TransferAction = 'send' | 'cancel'

export const IDEMPOTENCY_CONFLICT_MESSAGE = 'Sudah tercatat, muat ulang halaman ini.'

/** Units that leave the source on Kirim (and come back on a Batalkan of a sent transfer). */
export function transferUnits(t: Pick<Transfer, 'items'>): number {
  return t.items.reduce((sum, it) => sum + it.sentQty, 0)
}

const units = (n: number) => `${n.toLocaleString('id-ID')} unit`

export interface TransferConfirmCopy {
  title: string
  consequence: string
  confirmLabel: string
  cancelLabel: string
  tone: 'default' | 'danger'
}

/** Question, one-line consequence and button words for a transfer action. A draft moves no stock, so cancelling it says so. */
export function transferConfirmCopy(
  action: TransferAction,
  t: Pick<Transfer, 'transferNo' | 'status' | 'items' | 'source'> & { dest?: Pick<Transfer['dest'], 'name'> },
): TransferConfirmCopy {
  const source = t.source.name ?? 'sumber'
  if (action === 'send') {
    return {
      title: `Kirim transfer ${t.transferNo}?`,
      consequence: `Stok ${units(transferUnits(t))} akan keluar dari ${source} sekarang dan tercatat “Dikirim” sampai ${t.dest?.name ?? 'tujuan'} menerima.`,
      confirmLabel: 'Kirim transfer',
      cancelLabel: 'Batal',
      tone: 'default',
    }
  }
  return {
    title: `Batalkan transfer ${t.transferNo}?`,
    consequence:
      t.status === 'in_transit'
        ? `Stok ${units(transferUnits(t))} dikembalikan ke ${source} sekarang.`
        : 'Draf transfer dibatalkan. Stok tidak berubah.',
    confirmLabel: 'Batalkan transfer',
    cancelLabel: 'Kembali',
    tone: 'danger',
  }
}

/** The server's text when an Idempotency-Key was already used for another operation (service.ErrReceiptKeyConflict). */
const KEY_CONFLICT_TEXT = 'kunci idempotensi'

/** True for the 409 the server answers when an Idempotency-Key was already used for a different request. */
export function isIdempotencyConflict(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false
  const body = e.body as { data?: { code?: string } } | null | undefined
  return body?.data?.code === 'idempotency_conflict' || e.message.toLowerCase().includes(KEY_CONFLICT_TEXT)
}

export const TRANSFER_CHANGED_MESSAGE = 'Transfer berubah sejak pertanyaan ini dibuka. Tutup, lalu periksa status terbaru.'

/** What a dialog was opened for. The write carries only the transfer id, so the client must notice a change itself. */
export interface TransferSnapshot {
  status: string
  units: number
}

export const transferSnapshot = (t: Pick<Transfer, 'status' | 'items'>): TransferSnapshot => ({ status: t.status, units: transferUnits(t) })

/** True when the transfer is no longer what the dialog described (another user sent, cancelled or edited it). */
export function transferChangedSince(opened: TransferSnapshot, now: Pick<Transfer, 'status' | 'items'>): boolean {
  return opened.status !== now.status || opened.units !== transferUnits(now)
}

/** Text for a refused transfer action, shown inside the dialog. */
export function transferActionError(e: unknown): string {
  if (isIdempotencyConflict(e)) return IDEMPOTENCY_CONFLICT_MESSAGE
  return e instanceof Error && e.message ? e.message : 'Aksi gagal.'
}

/** The location the list is scoped to: the Lokasi filter, else the header outlet (D-84), else everything. */
export function effectiveLocation(lokasi: string, headerOutletId: string | null): { kind: 'outlet' | 'warehouse'; id: string } | null {
  const key = lokasi || (headerOutletId ? `outlet:${headerOutletId}` : '')
  const [kind, id] = key.split(':')
  return (kind === 'outlet' || kind === 'warehouse') && id ? { kind, id } : null
}
