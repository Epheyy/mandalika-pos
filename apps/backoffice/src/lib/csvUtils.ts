import * as XLSX from 'xlsx'
import { localDay } from './businessDay'

type Row = Record<string, unknown>

export function exportToXLSX(data: Row[], filename: string) {
  if (!data.length) return
  const ws = XLSX.utils.json_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  XLSX.writeFile(wb, `${filename}_${localDay()}.xlsx`)
}

/** Text cells starting with these can run as a spreadsheet formula (CSV injection). */
const FORMULA_TRIGGER = /^[=@\t\r]/
/** '+' / '-' only start a formula when what follows is not a plain number ("+62812...", "-5000" are fine). */
const SIGN_TRIGGER = /^[+-]/
const PLAIN_SIGNED_NUMBER = /^[+-]?\d+([.,]\d+)*$/

/**
 * One CSV cell. Only TEXT cells that could run as a formula get a leading apostrophe
 * (= @ tab CR, and + or - unless the cell is a plain number), so they open as text;
 * real numbers (including negative stock) stay numbers. The importer strips exactly
 * that one apostrophe again (backend csvimport), so a round trip is lossless.
 */
export function csvCell(val: unknown): string {
  let s = String(val ?? '')
  if (typeof val === 'string' && (FORMULA_TRIGGER.test(s) || (SIGN_TRIGGER.test(s) && !PLAIN_SIGNED_NUMBER.test(s)))) {
    s = `'${s}`
  }
  return /[,;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The whole CSV text: BOM + RFC 4180 records joined by CRLF, every cell through csvCell. */
export function buildCSV(data: Row[]): string {
  const headers = Object.keys(data[0])
  return '﻿' + [
    headers.map(csvCell).join(','),
    ...data.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ].join('\r\n')
}

export function exportToCSV(data: Row[], filename: string, opts: { appendDate?: boolean } = {}) {
  if (!data.length) return
  const blob = new Blob([buildCSV(data)], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = opts.appendDate === false ? `${filename}.csv` : `${filename}_${localDay()}.csv`
  a.click()
}

/**
 * Build an export base filename from a module name + context parts (active
 * filters/scope). Empty/nullish parts are dropped; each part is slugified.
 * exportToCSV/exportToXLSX still append `_YYYY-MM-DD` (the generation date),
 * so the result is e.g. `transfer-produk_selesai_mandalika-bsd_2026-06-06.csv`.
 */
export function buildExportName(
  base: string,
  parts: Array<string | number | null | undefined> = [],
): string {
  const slug = (s: string) =>
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
  const tail = parts.flatMap((p) => {
    if (p === null || p === undefined || p === '') return []
    const s = slug(String(p))
    return s ? [s] : []
  })
  const b = slug(base)
  return tail.length ? `${b}_${tail.join('_')}` : b
}

export function generateCode(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join('')
}
