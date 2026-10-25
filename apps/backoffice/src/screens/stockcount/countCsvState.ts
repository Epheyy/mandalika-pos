import type { StockCountImportReport, StockCountImportRow } from '@mandalika/api'

type RowWarning = StockCountImportRow['warnings'][number]

/** Row warning codes (the contract's StockCountImportWarning) in Indonesian. */
export const WARNING_LABEL: Record<RowWarning, string> = {
  unknown_code: 'Kode tidak dikenal',
  ambiguous_sku: 'SKU ganda, pakai barcode',
  not_on_count: 'Bukan bagian dari opname ini (tidak disimpan)',
  stock_moved_since_start: 'Stok bergerak sejak opname dimulai',
  baseline_replaced: 'Baseline input manual akan diganti snapshot awal opname',
  sku_narrowed: 'SKU dipakai beberapa produk; dicocokkan ke baris di opname ini',
}

/** Unknown or ambiguous codes, bad rows and file errors block "Terapkan" (the server refuses them too). */
export function hasBlockingErrors(r: StockCountImportReport): boolean {
  return (
    r.summary.unknown > 0 ||
    r.summary.ambiguous > 0 ||
    r.fileIssues.some((f) => f.severity === 'error') ||
    r.issues.some((i) => i.severity === 'error')
  )
}

/** Apply is useful only when it would store something new. */
export function canApplyCount(r: StockCountImportReport | null, busy: boolean): boolean {
  return !!r && !busy && !hasBlockingErrors(r) && r.summary.changed > 0
}

export function rowWarnings(row: StockCountImportRow): string {
  return row.warnings.map((w) => WARNING_LABEL[w] ?? w).join('; ')
}

export function summaryChips(r: StockCountImportReport): { key: string; label: string; value: number; bad: boolean }[] {
  const s = r.summary
  return [
    { key: 'matched', label: 'Cocok', value: s.matched, bad: false },
    { key: 'changed', label: 'Akan diubah', value: s.changed, bad: false },
    { key: 'uncounted', label: 'Belum dihitung', value: s.uncounted, bad: false },
    { key: 'notOnCount', label: 'Bukan di opname', value: s.notOnCount, bad: false },
    { key: 'unknown', label: 'Tidak dikenal', value: s.unknown, bad: s.unknown > 0 },
    { key: 'ambiguous', label: 'SKU ganda', value: s.ambiguous, bad: s.ambiguous > 0 },
  ]
}

/** The 422 body carries the report under data. */
export function reportFromErrorBody(body: unknown): StockCountImportReport | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as { data?: unknown }).data
  return data && typeof data === 'object' && 'summary' in data ? (data as StockCountImportReport) : null
}
