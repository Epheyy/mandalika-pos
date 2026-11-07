import { ERROR_KIND } from './errorSource'
import { labelOf } from './types'

/** Message rules, first match wins. Messages are free text from the tablet and backend, so this matches on what they say, never on exact strings. */
const MESSAGE_RULES: ReadonlyArray<{ test: RegExp; text: string }> = [
  { test: /order rejected|rejected|ditolak/i, text: 'Transaksi ditolak server' },
  { test: /failed to fetch|network|timeout|timed out|offline|econn|koneksi/i, text: 'Koneksi ke server terputus' },
  { test: /unauthori[sz]ed|forbidden|\b40[13]\b|tidak berwenang/i, text: 'Tidak punya izin untuk tindakan ini' },
  { test: /\b422\b|validation|invalid|tidak valid/i, text: 'Data ditolak server karena tidak valid' },
  { test: /\b5\d\d\b|internal server|panic/i, text: 'Terjadi kesalahan di server' },
  { test: /quota|storage|penyimpanan|disk|indexeddb|localstorage/i, text: 'Penyimpanan di tablet gagal' },
  { test: /print|cetak|printer|bluetooth/i, text: 'Pencetakan gagal' },
  { test: /sync gagal|sync failed/i, text: 'Sinkronisasi gagal' },
]

export interface ErrorMessageText {
  /** Human Indonesian summary for the list and the panel heading. */
  summary: string
  /** The original text, kept for "Detail teknis". Empty when there is none. */
  raw: string
}

/** Human summary of a logged error; the raw message is never the summary. Unknown text falls back to the kind label ("Penjualan gagal"), then a generic line. */
export function errorMessageText(message: string | null | undefined, kind?: string | null): ErrorMessageText {
  const raw = (message ?? '').trim()
  const rule = MESSAGE_RULES.find((r) => r.test.test(raw))
  if (rule) return { summary: rule.text, raw }
  const kindLabel = kind ? labelOf(ERROR_KIND, kind) : null
  const summary = kindLabel && kindLabel.label !== 'Lainnya' ? `${kindLabel.label} gagal` : 'Terjadi kesalahan'
  return { summary, raw }
}
