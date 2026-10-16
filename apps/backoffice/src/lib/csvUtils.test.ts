import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { csvCell, exportToXLSX } from './csvUtils'

vi.mock('xlsx', async (original) => ({
  ...await original<typeof import('xlsx')>(), writeFile: vi.fn(),
}))

describe('existing XLSX export contract', () => {
  beforeEach(() => vi.mocked(XLSX.writeFile).mockClear())

  it('does not download an empty dataset', () => {
    exportToXLSX([], 'empty')
    expect(XLSX.writeFile).not.toHaveBeenCalled()
  })

  it('preserves ordered headers, text IDs, Unicode, amounts, blanks and date text', () => {
    const row = {
      'No. Order': '0000123', Tanggal: '2026-09-23 10:05', Kasir: 'Ni Luh Äyu 香 🌺',
      Pelanggan: '', Item: 'Melati 110 ml x2; Mawar 10 ml x1', Total: 12345.5,
      Diskon: 0, FormulaLike: '=1+1', Plus: '+628123', Minus: '-123', At: '@SUM(A1)',
    }
    exportToXLSX([row], 'typed')
    const [book, filename] = vi.mocked(XLSX.writeFile).mock.calls[0]
    expect(filename).toMatch(/^typed_\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(book.SheetNames).toEqual(['Data'])
    const sheet = book.Sheets.Data
    expect(XLSX.utils.sheet_to_json(sheet, { header: 1 })[0]).toEqual(Object.keys(row))
    expect(XLSX.utils.sheet_to_json(sheet)).toEqual([row])
    for (const address of ['A2', 'B2', 'C2', 'D2', 'E2', 'H2', 'I2', 'J2', 'K2']) {
      expect(sheet[address].t).toBe('s')
      expect(sheet[address].f).toBeUndefined()
    }
    expect(sheet.F2).toMatchObject({ t: 'n', v: 12345.5 })
    expect(sheet.G2).toMatchObject({ t: 'n', v: 0 })
    const serialized = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
    const readback = XLSX.read(serialized)
    expect(XLSX.utils.sheet_to_json(readback.Sheets.Data)).toEqual([row])
  })
})

describe('csvCell formula safety (A44/A39)', () => {
  it('prefixes text cells that start with a formula trigger', () => {
    for (const t of ['=1+1', '+628123', '-123', '@SUM(A1)', '\tcmd', '\rcmd']) {
      expect(csvCell(t).replace(/^"|"$/g, '').startsWith("'")).toBe(true)
    }
  })

  it('keeps numbers numeric, including negatives (negative stock)', () => {
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell(12345.5)).toBe('12345.5')
    expect(csvCell(0)).toBe('0')
  })

  it('leaves ordinary text untouched and still quotes commas, quotes and newlines', () => {
    expect(csvCell('Melati 110 ml')).toBe('Melati 110 ml')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('x\ny')).toBe('"x\ny"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('escapes after prefixing so a quoted formula stays one safe cell', () => {
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"')
  })
})
