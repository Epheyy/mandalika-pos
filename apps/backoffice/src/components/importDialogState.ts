import type { ImportKind, ImportReport, ImportSummary } from '@mandalika/api'

/** Pure state machine of the CSV import dialog (A39). The server owns validation; this only
 *  tracks which step the user is on and what the next call may carry. */
export type ImportPhase =
  | 'idle' // nothing chosen yet
  | 'previewing' // dry run in flight
  | 'ready' // a preview report is on screen
  | 'applying' // commit in flight
  | 'applied' // committed (or replayed)
  | 'stale' // 409: data changed since the preview, or the key was reused for another file
  | 'rejected' // 422: row/file errors, nothing written
  | 'failed' // network / server failure (report and key are kept for a retry)

export interface ImportState {
  phase: ImportPhase
  fileName: string
  csv: string | null
  report: ImportReport | null
  /** Idempotency-Key: generated once per preview and reused on retry of the same apply. */
  key: string | null
  message: string | null
}

export type ImportAction =
  | { type: 'pick'; fileName: string; csv: string }
  | { type: 'pickFailed'; message: string }
  | { type: 'previewOk'; report: ImportReport; key: string }
  | { type: 'previewFailed'; message: string }
  | { type: 'apply' }
  | { type: 'applyOk'; report: ImportReport }
  | { type: 'applyStale'; message: string }
  | { type: 'applyRejected'; report: ImportReport; message: string }
  | { type: 'applyFailed'; message: string }
  | { type: 'reset' }

export const initialImportState: ImportState = {
  phase: 'idle', fileName: '', csv: null, report: null, key: null, message: null,
}

export function importReducer(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case 'pick':
      return { ...initialImportState, phase: 'previewing', fileName: action.fileName, csv: action.csv }
    case 'pickFailed':
      return { ...initialImportState, message: action.message }
    case 'previewOk':
      if (state.phase !== 'previewing' && state.phase !== 'stale') return state
      return { ...state, phase: 'ready', report: action.report, key: action.key, message: null }
    case 'previewFailed':
      return { ...state, phase: 'failed', report: null, key: null, message: action.message }
    case 'apply':
      if (!canApply(state)) return state
      return { ...state, phase: 'applying', message: null }
    case 'applyOk':
      return { ...state, phase: 'applied', report: action.report, message: null }
    case 'applyStale':
      // The old report no longer describes the data: re-preview before anything else.
      return { ...state, phase: 'stale', key: null, message: action.message }
    case 'applyRejected':
      return { ...state, phase: 'rejected', report: action.report, key: null, message: action.message }
    case 'applyFailed':
      // Keep report and key: a retry of the same apply must carry the same Idempotency-Key.
      return { ...state, phase: 'failed', message: action.message }
    case 'reset':
      return initialImportState
  }
}

/** Terapkan is only available on a clean preview that would change something. */
export function canApply(state: ImportState): boolean {
  if (state.phase !== 'ready' && state.phase !== 'failed') return false
  const r = state.report
  if (!r || !state.key) return false
  return !hasBlockingErrors(r) && r.summary.create + r.summary.update > 0
}

export function hasBlockingErrors(report: ImportReport): boolean {
  return report.summary.error > 0 || report.fileIssues.some((f) => f.severity === 'error')
}

export const SUMMARY_LABELS: ReadonlyArray<{ key: keyof ImportSummary; label: string }> = [
  { key: 'create', label: 'Baru' },
  { key: 'update', label: 'Diperbarui' },
  { key: 'skip', label: 'Dilewati' },
  { key: 'error', label: 'Error' },
  { key: 'warning', label: 'Peringatan' },
  { key: 'newCategories', label: 'Kategori baru' },
]

export function summaryChips(summary: ImportSummary): Array<{ label: string; value: number; key: keyof ImportSummary }> {
  return SUMMARY_LABELS.map(({ key, label }) => ({ key, label, value: summary[key] }))
}

export function appliedMessage(report: ImportReport): string {
  const s = report.summary
  const parts = [`${s.create} dibuat`, `${s.update} diperbarui`, `${s.skip} dilewati`]
  if (s.newCategories) parts.push(`${s.newCategories} kategori baru`)
  return parts.join(', ')
}

/** Rows of the downloadable "laporan error" (goes through exportToCSV, so it is formula-safe). */
export function errorReportRows(report: ImportReport): Array<Record<string, string | number>> {
  const file = report.fileIssues.map((f) => ({
    Baris: '', 'Baris di file': '', Kolom: f.column ?? '', Tingkat: f.severity === 'error' ? 'Error' : 'Peringatan',
    Kode: f.code, Pesan: f.message, Nilai: '',
  }))
  const rows = report.issues.map((i) => ({
    Baris: i.row, 'Baris di file': i.line, Kolom: i.column ?? '',
    Tingkat: i.severity === 'error' ? 'Error' : 'Peringatan',
    Kode: i.code, Pesan: i.message, Nilai: i.value ?? '',
  }))
  return [...file, ...rows]
}

export const MAX_IMPORT_BYTES = 16 * 1024 * 1024

/** Client-side file checks (size and extension only; the server validates the content). */
export function checkPickedFile(name: string, size: number): string | null {
  if (!/\.csv$/i.test(name)) return 'Pilih file berekstensi .csv (simpan dari Excel sebagai "CSV UTF-8").'
  if (size > MAX_IMPORT_BYTES) return 'File lebih besar dari 16 MiB.'
  if (size === 0) return 'File kosong.'
  return null
}

export const ENCODING_MESSAGE = 'File bukan UTF-8: simpan sebagai "CSV UTF-8" dari Excel lalu coba lagi.'

/** Decode the file bytes strictly: an ANSI file must be refused, not silently mangled. */
export function decodeUtf8(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export const KIND_TITLE: Record<ImportKind, string> = {
  customers: 'Impor Pelanggan',
  products: 'Impor Produk',
  ingredients: 'Impor Bahan',
}
