import { describe, expect, it } from 'vitest'
import type { ImportReport } from '@mandalika/api'
import {
  appliedMessage, canApply, checkPickedFile, decodeUtf8, errorReportRows, importReducer,
  initialImportState, summaryChips,
} from './importDialogState'
import { buildCSV } from '../lib/csvUtils'

function report(over: Partial<ImportReport> = {}): ImportReport {
  return {
    kind: 'customers', delimiter: ',', fileSha256: 'abc', totalRows: 3,
    summary: { create: 2, update: 0, skip: 1, error: 0, warning: 0, newCategories: 0 },
    fileIssues: [], issues: [], rows: [], ...over,
  }
}

const picked = importReducer(initialImportState, { type: 'pick', fileName: 'a.csv', csv: 'x' })
const ready = importReducer(picked, { type: 'previewOk', report: report(), key: 'k1' })

describe('importReducer', () => {
  it('pick -> previewing -> ready, carrying the key', () => {
    expect(picked.phase).toBe('previewing')
    expect(ready).toMatchObject({ phase: 'ready', key: 'k1', fileName: 'a.csv' })
    expect(canApply(ready)).toBe(true)
  })

  it('a preview with row errors blocks Terapkan', () => {
    const s = importReducer(picked, { type: 'previewOk', report: report({ summary: { create: 1, update: 0, skip: 0, error: 1, warning: 0, newCategories: 0 } }), key: 'k' })
    expect(canApply(s)).toBe(false)
    expect(importReducer(s, { type: 'apply' }).phase).toBe('ready') // refused, no state change
  })

  it('a file-level error blocks Terapkan even with a zero error count', () => {
    const s = importReducer(picked, { type: 'previewOk', report: report({ fileIssues: [{ severity: 'error', code: 'bad_csv', message: 'x' }] }), key: 'k' })
    expect(canApply(s)).toBe(false)
  })

  it('warnings do not block, but an all-skip preview has nothing to apply', () => {
    const warn = importReducer(picked, { type: 'previewOk', report: report({ summary: { create: 1, update: 0, skip: 0, error: 0, warning: 3, newCategories: 0 } }), key: 'k' })
    expect(canApply(warn)).toBe(true)
    const none = importReducer(picked, { type: 'previewOk', report: report({ summary: { create: 0, update: 0, skip: 3, error: 0, warning: 0, newCategories: 0 } }), key: 'k' })
    expect(canApply(none)).toBe(false)
  })

  it('apply -> applied', () => {
    const applying = importReducer(ready, { type: 'apply' })
    expect(applying.phase).toBe('applying')
    const done = importReducer(applying, { type: 'applyOk', report: report({ runId: 'r1' }) })
    expect(done.phase).toBe('applied')
    expect(done.report?.runId).toBe('r1')
  })

  it('stale drops the key so a re-preview issues a new one, then returns to ready', () => {
    const stale = importReducer(importReducer(ready, { type: 'apply' }), { type: 'applyStale', message: 'berubah' })
    expect(stale).toMatchObject({ phase: 'stale', key: null, message: 'berubah' })
    expect(canApply(stale)).toBe(false)
    const again = importReducer(stale, { type: 'previewOk', report: report(), key: 'k2' })
    expect(again).toMatchObject({ phase: 'ready', key: 'k2' })
  })

  it('a 422 replaces the report with the server one and blocks apply', () => {
    const bad = report({ summary: { create: 0, update: 0, skip: 0, error: 2, warning: 0, newCategories: 0 } })
    const s = importReducer(importReducer(ready, { type: 'apply' }), { type: 'applyRejected', report: bad, message: 'ditolak' })
    expect(s).toMatchObject({ phase: 'rejected', key: null })
    expect(s.report?.summary.error).toBe(2)
    expect(canApply(s)).toBe(false)
  })

  it('a network failure keeps the report and the SAME key so a retry is idempotent', () => {
    const failed = importReducer(importReducer(ready, { type: 'apply' }), { type: 'applyFailed', message: 'offline' })
    expect(failed).toMatchObject({ phase: 'failed', key: 'k1' })
    expect(canApply(failed)).toBe(true)
    expect(importReducer(failed, { type: 'apply' }).key).toBe('k1')
  })

  it('previewOk is ignored when no preview is in flight', () => {
    expect(importReducer(initialImportState, { type: 'previewOk', report: report(), key: 'k' })).toBe(initialImportState)
  })

  it('pickFailed and reset return to a clean state', () => {
    expect(importReducer(ready, { type: 'pickFailed', message: 'x' })).toMatchObject({ phase: 'idle', message: 'x', report: null })
    expect(importReducer(ready, { type: 'reset' })).toEqual(initialImportState)
  })
})

describe('import helpers', () => {
  it('summaryChips lists every counter in a fixed order', () => {
    expect(summaryChips(report().summary).map((c) => c.label)).toEqual(['Baru', 'Diperbarui', 'Dilewati', 'Error', 'Peringatan', 'Kategori baru'])
  })

  it('appliedMessage mentions new categories only when there are some', () => {
    expect(appliedMessage(report())).toBe('2 dibuat, 0 diperbarui, 1 dilewati')
    expect(appliedMessage(report({ summary: { create: 1, update: 1, skip: 0, error: 0, warning: 0, newCategories: 2 } }))).toContain('2 kategori baru')
  })

  it('error report rows are formula-safe when exported (hostile value stays text)', () => {
    const rows = errorReportRows(report({
      fileIssues: [{ severity: 'warning', code: 'unknown_column', message: 'kolom "X"', column: 'X' }],
      issues: [{ row: 3, line: 5, column: 'Nama', severity: 'error', code: 'required', message: 'wajib', value: '=HYPERLINK("http://x")' }],
    }))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ Baris: 3, 'Baris di file': 5, Tingkat: 'Error', Kode: 'required' })
    const csv = buildCSV(rows)
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`)
  })

  it('checkPickedFile only accepts a non-empty .csv up to 16 MiB', () => {
    expect(checkPickedFile('a.csv', 10)).toBeNull()
    expect(checkPickedFile('A.CSV', 10)).toBeNull()
    expect(checkPickedFile('a.xlsx', 10)).toMatch(/\.csv/)
    expect(checkPickedFile('a.csv', 16 * 1024 * 1024 + 1)).toMatch(/16 MiB/)
    expect(checkPickedFile('a.csv', 0)).toMatch(/kosong/)
  })

  it('decodeUtf8 refuses a non-UTF-8 (ANSI) file instead of mangling it', () => {
    expect(decodeUtf8(new TextEncoder().encode('Äyu 香').buffer as ArrayBuffer)).toBe('Äyu 香')
    expect(decodeUtf8(new Uint8Array([0x4e, 0xe9, 0x61]).buffer)).toBeNull() // "Néa" in Windows-1252
  })
})

