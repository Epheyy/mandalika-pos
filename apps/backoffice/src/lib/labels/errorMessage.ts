import { ERROR_KIND } from './errorSource'
import { labelOf } from './types'

/** Message rules, first match wins. Messages are free text from the tablet and backend, so this matches on what they say, never on exact strings. */
const MESSAGE_RULES: ReadonlyArray<{ test: RegExp; text: string }> = [
  { test: /order rejected|\brejected\b.*\b(?:order|sync)\b|\bditolak\b/i, text: 'Transaksi ditolak server' },
  { test: /failed to fetch|network|timed out|timeout|offline|econn|koneksi/i, text: 'Koneksi ke server terputus' },
  { test: /unauthori[sz]ed|forbidden|\b(?:http|status)\s*40[13]\b|tidak berwenang/i, text: 'Tidak punya izin untuk tindakan ini' },
  { test: /\b(?:http|status)\s*422\b|validation failed|tidak valid/i, text: 'Data ditolak server karena tidak valid' },
  { test: /\b(?:http|status)\s*5\d\d\b|internal server/i, text: 'Terjadi kesalahan di server' },
  { test: /quota|storage|penyimpanan|indexeddb|localstorage/i, text: 'Penyimpanan di tablet gagal' },
  { test: /\bprint|cetak|bluetooth/i, text: 'Pencetakan gagal' },
  { test: /sync gagal|sync failed/i, text: 'Sinkronisasi gagal' },
]

/** Client-side crashes: the server rules never apply (a Promise "rejected" or an "Invalid time value" is not the server's doing). */
const CLIENT_KINDS: ReadonlySet<string> = new Set(['uncaught', 'unhandledrejection'])
/** Kinds whose label names an action, so "<label> gagal" reads right. Other labels already describe the failure. */
const ACTION_KINDS: ReadonlySet<string> = new Set(['order', 'refund', 'shift_open', 'shift_close', 'cash_flow', 'customer_create', 'transfer_receive', 'receipt', 'tanda_terima'])

export interface ErrorMessageText {
  /** Human Indonesian summary for the list and the panel heading. */
  summary: string
  /** The original text, kept for "Detail teknis". Empty when there is none. */
  raw: string
}

/** Human summary of a logged error; the raw message is never the summary. Unknown text falls back to the kind label ("Penjualan gagal"), then a generic line. */
export function errorMessageText(message: string | null | undefined, kind?: string | null, source?: string | null): ErrorMessageText {
  const raw = (message ?? '').trim()
  if (kind === 'panic') return { summary: 'Terjadi kesalahan di server', raw }
  if (source === 'print') return { summary: 'Pencetakan gagal', raw }
  const rule = kind && CLIENT_KINDS.has(kind) ? undefined : MESSAGE_RULES.find((r) => r.test.test(raw))
  if (rule) return { summary: rule.text, raw }
  const kindLabel = kind ? labelOf(ERROR_KIND, kind) : null
  const summary = !kindLabel || kindLabel.label === 'Lainnya' ? 'Terjadi kesalahan' : kind && ACTION_KINDS.has(kind) ? `${kindLabel.label} gagal` : kindLabel.label
  return { summary, raw }
}
