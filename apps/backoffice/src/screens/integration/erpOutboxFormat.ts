import type { ErpOutboxItem, ErpRelayReport } from '@mandalika/api'

export type ErpStatus = ErpOutboxItem['status']
export type ErpKind = ErpOutboxItem['kind']
export type ErpTone = 'success' | 'danger' | 'warning' | 'neutral'

export const STATUS_LABEL: Record<ErpStatus, string> = {
  pending: 'Menunggu',
  held: 'Ditahan',
  sending: 'Mengirim',
  delivered: 'Terkirim',
  replayed: 'Diulang',
  dead: 'Gagal',
}

const STATUS_TONE: Record<ErpStatus, ErpTone> = {
  dead: 'danger',
  held: 'warning',
  delivered: 'success',
  replayed: 'success',
  pending: 'neutral',
  sending: 'neutral',
}

export const KIND_LABEL: Record<ErpKind, string> = {
  sale: 'Penjualan',
  refund: 'Retur',
  transfer_out: 'Transfer keluar',
  transfer_in: 'Transfer masuk',
  transfer_cancel: 'Batal transfer',
  receipt: 'Penerimaan',
  adjust: 'Penyesuaian',
  count: 'Stok opname',
  opening: 'Saldo awal',
  write_off: 'Penghapusan',
}

// Tab order; the Record type makes a new status a compile error here too.
const STATUS_RANK: Record<ErpStatus, number> = { dead: 0, held: 1, pending: 2, sending: 3, delivered: 4, replayed: 5 }
export const STATUS_ORDER = (Object.keys(STATUS_RANK) as ErpStatus[]).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])
export const KIND_ORDER = Object.keys(KIND_LABEL) as ErpKind[]

export const statusLabel = (s: ErpStatus): string => STATUS_LABEL[s] ?? s
export const statusTone = (s: ErpStatus): ErpTone => STATUS_TONE[s] ?? 'neutral'
export const kindLabel = (k: ErpKind): string => KIND_LABEL[k] ?? k

/** Statuses a document can be re-queued from (server answers 409 for pending/sending). */
export const canRetry = (s: ErpStatus): boolean =>
  s === 'dead' || s === 'held' || s === 'delivered' || s === 'replayed'

const shortId = (id: string): string => id.slice(0, 8)

export function refText(i: Pick<ErpOutboxItem, 'refNumber' | 'refId' | 'part' | 'partCount'>): string {
  const base = i.refNumber || shortId(i.refId)
  return i.partCount > 1 ? `${base} (bagian ${i.part}/${i.partCount})` : base
}

export const locationText = (i: Pick<ErpOutboxItem, 'locationType' | 'locationId'>): string =>
  `${i.locationType} ${shortId(i.locationId)}`

const STOP_TEXT: Record<NonNullable<ErpRelayReport['stopped']>, string> = {
  unauthorized: 'dihentikan: kunci API ERP ditolak (401), dokumen tetap menunggu',
  forbidden: 'dihentikan: akses ERP ditolak (403), dokumen tetap menunggu',
  rate_limited: 'dihentikan: ERP membatasi permintaan (429), dicoba lagi nanti',
  budget: 'dihentikan: batas waktu run habis, sisa dokumen dikirim pada run berikutnya',
}

export function relayMessage(r: ErpRelayReport): string {
  if (r.disabled) {
    return r.reason === 'invalid ERP relay config'
      ? 'Relay nonaktif: konfigurasi ERP tidak valid (periksa ERP_BASE_URL / ERP_API_KEY)'
      : 'Relay nonaktif (ERP_RELAY_ENABLED mati)'
  }
  const base = `Terkirim ${r.delivered}, sudah ada di ERP ${r.replayed}, dijadwalkan ulang ${r.retried}, ` +
    `ditahan ${r.held}, gagal ${r.dead}, dikembalikan ke antrean ${r.released}`
  return r.stopped ? `${base}; ${STOP_TEXT[r.stopped]}` : base
}

/** Whether the next-attempt time means anything for this status. */
export const showsNextAttempt = (s: ErpStatus): boolean => s === 'pending' || s === 'held'

const EMPTY_WORD: Record<ErpStatus, string> = {
  pending: 'menunggu', held: 'ditahan', sending: 'sedang dikirim', delivered: 'terkirim', replayed: 'diulang', dead: 'gagal',
}

export const emptyTitle = (status: ErpStatus | ''): string =>
  status === '' ? 'Tidak ada dokumen' : `Tidak ada dokumen ${EMPTY_WORD[status]}`
