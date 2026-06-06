import * as XLSX from 'xlsx'

type Row = Record<string, unknown>

export function exportToXLSX(data: Row[], filename: string) {
  if (!data.length) return
  const ws = XLSX.utils.json_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  XLSX.writeFile(wb, `${filename}_${new Date().toISOString().slice(0, 10)}.xlsx`)
}

export function exportToCSV(data: Row[], filename: string) {
  if (!data.length) return
  const headers = Object.keys(data[0])
  const escape = (val: unknown) => {
    const s = String(val ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const csv = [
    headers.join(','),
    ...data.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
}

/**
 * Pick the field delimiter by counting candidates in the header line (outside
 * quotes). Excel exports CSV with ';' in locales where ',' is the decimal
 * separator (Indonesia/Europe), and tab-separated files also turn up — so we
 * auto-detect instead of assuming ','.
 */
function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t']
  let best = ','
  let bestCount = -1
  for (const d of candidates) {
    let count = 0
    let inQuote = false
    for (const ch of headerLine) {
      if (ch === '"') inQuote = !inQuote
      else if (ch === d && !inQuote) count++
    }
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

export function parseCSV(text: string): Record<string, string>[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => l.trim())
  if (lines.length < 2) return []
  const delim = detectDelimiter(lines[0])
  const splitLine = (line: string): string[] => {
    const values: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuote = !inQuote
      else if (line[i] === delim && !inQuote) {
        values.push(cur.trim())
        cur = ''
      } else cur += line[i]
    }
    values.push(cur.trim())
    return values
  }
  const headers = splitLine(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim())
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const values = splitLine(line)
      return headers.reduce(
        (obj, h, i) => ({ ...obj, [h]: values[i] || '' }),
        {} as Record<string, string>,
      )
    })
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
  const tail = parts
    .map((p) => (p === null || p === undefined || p === '' ? '' : slug(String(p))))
    .filter(Boolean)
  const b = slug(base)
  return tail.length ? `${b}_${tail.join('_')}` : b
}

export function generateCode(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join('')
}
