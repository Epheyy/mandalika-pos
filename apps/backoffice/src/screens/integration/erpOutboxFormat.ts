import type { ErpOutboxItem, ErpRelayReport } from '@mandalika/api'
import { ERP_KIND, ERP_STATUS } from '../../lib/labels/erp'

export type ErpStatus = ErpOutboxItem['status']
export type ErpKind = ErpOutboxItem['kind']

export const STATUS_LABEL = Object.fromEntries(
  Object.entries(ERP_STATUS).map(([k, v]) => [k, v.label]),
) as Record<ErpStatus, string>

export const KIND_LABEL = Object.fromEntries(
  Object.entries(ERP_KIND).map(([k, v]) => [k, v.label]),
) as Record<ErpKind, string>

// Tab order; the Record type makes a new status a compile error here too.
const STATUS_RANK: Record<ErpStatus, number> = { dead: 0, held: 1, pending: 2, sending: 3, delivered: 4, replayed: 5 }
export const STATUS_ORDER = (Object.keys(STATUS_RANK) as ErpStatus[]).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])
export const KIND_ORDER = Object.keys(KIND_LABEL) as ErpKind[]

export const kindLabel = (k: ErpKind): string => KIND_LABEL[k] ?? k

/** Statuses a document can be re-queued from (server answers 409 for pending/sending). */
export function canRetry(s: ErpStatus): boolean {
  return s === 'dead' || s === 'held' || s === 'delivered' || s === 'replayed'
}

const shortId = (id: string): string => id.slice(0, 8)

export function refText(i: Pick<ErpOutboxItem, 'refNumber' | 'refId' | 'part' | 'partCount'>): string {
  const base = i.refNumber || shortId(i.refId)
  return i.partCount > 1 ? `${base} (bagian ${i.part}/${i.partCount})` : base
}

const LOCATION_TYPE: Record<ErpOutboxItem['locationType'], string> = { outlet: 'Outlet', warehouse: 'Gudang' }

/** The location's name; a deleted location (no name) falls back to its type and short id. */
export function locationText(i: Pick<ErpOutboxItem, 'locationType' | 'locationId' | 'locationName'>): string {
  const name = i.locationName?.trim()
  if (name) return name
  return `${LOCATION_TYPE[i.locationType] ?? i.locationType} ${shortId(i.locationId)}`
}

/** URL value of the "Semua" status chip. An empty value would be dropped from the URL and read back as the default. */
export const ALL_STATUSES = 'semua'

/** The status filter the list asks the server for; undefined = every status. */
export function statusFilterOf(value: string): ErpStatus | undefined {
  return (STATUS_ORDER as readonly string[]).includes(value) ? (value as ErpStatus) : undefined
}

/** A kind from the URL, or '' when it is not a known kind (a pasted link must not send junk to the server). */
export function kindFilterOf(value: string): ErpKind | '' {
  return (KIND_ORDER as readonly string[]).includes(value) ? (value as ErpKind) : ''
}

const STOP_TEXT: Record<NonNullable<ErpRelayReport['stopped']>, string> = {
  unauthorized: 'Dihentikan: kunci API ERP ditolak (401). Dokumen tetap menunggu.',
  forbidden: 'Dihentikan: akses ke ERP ditolak (403). Dokumen tetap menunggu.',
  rate_limited: 'Dihentikan: ERP membatasi permintaan (429). Dicoba lagi nanti.',
  budget: 'Dihentikan: batas waktu run habis. Sisa dokumen dikirim pada run berikutnya.',
}

export interface RelaySummary {
  /** The relay did not run at all. */
  disabled: boolean
  /** One plain sentence; set when the relay is off or the run stopped early. */
  headline: string | null
  /** Terkirim = delivered + already at the ERP; Ditahan = held; Gagal = dead. Empty when disabled. */
  counts: ReadonlyArray<{ label: 'Terkirim' | 'Ditahan' | 'Gagal'; value: number }>
  /** Everything else, including setting names, for the "Detail teknis" toggle. */
  technical: ReadonlyArray<string>
}

export function relaySummary(r: ErpRelayReport): RelaySummary {
  if (r.disabled) {
    const badConfig = r.reason === 'invalid ERP relay config'
    return {
      disabled: true,
      headline: badConfig
        ? 'Relay nonaktif: konfigurasi ERP di server tidak valid.'
        : 'Relay nonaktif: pengiriman ke ERP dimatikan di server.',
      counts: [],
      technical: [badConfig ? 'Periksa ERP_BASE_URL dan ERP_API_KEY.' : 'ERP_RELAY_ENABLED mati.'],
    }
  }
  const technical = [
    `Diklaim ${r.claimed}`,
    `Terkirim ${r.delivered}`,
    `Sudah ada di ERP ${r.replayed}`,
    `Dijadwalkan ulang ${r.retried}`,
    `Dikembalikan ke antrean ${r.released}`,
  ]
  return {
    disabled: false,
    headline: r.stopped ? STOP_TEXT[r.stopped] : null,
    counts: [
      { label: 'Terkirim', value: r.delivered + r.replayed },
      { label: 'Ditahan', value: r.held },
      { label: 'Gagal', value: r.dead },
    ],
    technical,
  }
}

/** What "Kirim ulang" will do, by the last HTTP status: 400/422 means the ERP wrote nothing, so the body is rebuilt. */
export function retryConsequence(i: Pick<ErpOutboxItem, 'status' | 'lastHttpStatus'>): string {
  const rebuilt = i.lastHttpStatus === 400 || i.lastHttpStatus === 422
  const how = rebuilt
    ? 'Karena ERP menolak isinya (400/422), dokumen dibangun ulang dari pemetaan terkini lalu dikirim.'
    : 'Isi yang sama dikirim lagi ke ERP.'
  const settled = i.status === 'delivered' || i.status === 'replayed'
  return `${settled ? 'Dokumen ini sudah ditandai terkirim. ' : ''}Dokumen dijadwalkan ulang dan dikirim pada giliran berikutnya. ${how}`
}

/** Whether the next-attempt time means anything for this status. */
export const showsNextAttempt = (s: ErpStatus): boolean => s === 'pending' || s === 'held'

const EMPTY_WORD: Record<ErpStatus, string> = {
  pending: 'menunggu', held: 'ditahan', sending: 'sedang dikirim', delivered: 'terkirim', replayed: 'diulang', dead: 'gagal',
}

export const emptyTitle = (status: ErpStatus | ''): string =>
  status === '' ? 'Tidak ada dokumen' : `Tidak ada dokumen ${EMPTY_WORD[status]}`

/**
 * The reason column in plain words. The raw server text (`holdReason`, `lastError`) stays in the detail's
 * "Detail teknis"; a table row never shows an HTTP error body. Null when there is nothing to say.
 */
export function humanReason(i: Pick<ErpOutboxItem, 'holdReason' | 'lastError' | 'lastHttpStatus'>): string | null {
  if (i.holdReason) return 'Ditahan, menunggu ditinjau'
  const http = i.lastHttpStatus
  if (http === 401 || http === 403) return `ERP menolak akses (HTTP ${http}), periksa kredensial`
  if (http === 408 || http === 429) return `ERP sibuk, akan dicoba lagi (HTTP ${http})`
  if (http != null && http >= 500) return `ERP sedang bermasalah (HTTP ${http})`
  if (http != null && http >= 400) return `ERP menolak dokumen (HTTP ${http})`
  if (i.lastError) return 'Gagal mengirim ke ERP'
  return null
}
