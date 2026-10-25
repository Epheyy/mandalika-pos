import { describe, expect, it } from 'vitest'
import type { StockCountImportReport } from '@mandalika/api'
import { canApplyCount, hasBlockingErrors, reportFromErrorBody, rowWarnings } from './countCsvState'

const report = (over: Partial<StockCountImportReport['summary']> = {}, extra: Partial<StockCountImportReport> = {}): StockCountImportReport => ({
  kind: 'stock_count',
  delimiter: ',',
  fileSha256: 'abc',
  totalRows: 2,
  summary: { matched: 2, unknown: 0, ambiguous: 0, notOnCount: 0, uncounted: 1, changed: 2, ...over },
  fileIssues: [],
  issues: [],
  rows: [],
  uncounted: [],
  ...extra,
})

describe('count CSV state', () => {
  it('allows apply only for a clean file that changes something', () => {
    expect(canApplyCount(report(), false)).toBe(true)
    expect(canApplyCount(report({ changed: 0 }), false)).toBe(false)
    expect(canApplyCount(report(), true)).toBe(false)
    expect(canApplyCount(null, false)).toBe(false)
  })

  it('blocks on unknown or ambiguous codes and on error issues', () => {
    expect(hasBlockingErrors(report({ unknown: 1 }))).toBe(true)
    expect(hasBlockingErrors(report({ ambiguous: 1 }))).toBe(true)
    expect(
      hasBlockingErrors(report({}, { issues: [{ row: 1, line: 2, severity: 'error', code: 'invalid_qty', message: 'x' }] })),
    ).toBe(true)
    expect(
      hasBlockingErrors(report({}, { issues: [{ row: 1, line: 2, severity: 'warning', code: 'not_on_count', message: 'x' }] })),
    ).toBe(false)
  })

  it('labels row warnings and reads the 422 report', () => {
    expect(rowWarnings({ row: 1, code: 'x', counted: 1, warnings: ['stock_moved_since_start'] })).toContain('bergerak')
    expect(reportFromErrorBody({ data: report(), error: 'x' })?.kind).toBe('stock_count')
    expect(reportFromErrorBody({ error: 'x' })).toBeNull()
  })
})
