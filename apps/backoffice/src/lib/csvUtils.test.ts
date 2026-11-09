import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { buildCSV, csvCell, exportToXLSX } from './csvUtils'
import golden from '../../../../backend/internal/csvimport/testdata/export_golden.csv?raw'

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
    for (const t of ['=1+1', '@SUM(A1)', '\tcmd', '\rcmd', '-2+3', '+cmd|calc', '-A1', '+1+1']) {
      expect(csvCell(t).replace(/^"|"$/g, '').startsWith("'")).toBe(true)
    }
  })

  it('leaves signed plain numbers and phone numbers readable, prefixes lone signs and expressions', () => {
    expect(csvCell('+628123')).toBe('+628123')
    expect(csvCell('-5000')).toBe('-5000')
    expect(csvCell('-1.500,5')).toBe('"-1.500,5"')
    expect(csvCell('-')).toBe('-')
    expect(csvCell('-2+3')).toBe("'-2+3")
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

describe('buildCSV (RFC 4180 writer, A39)', () => {
  const rows = [
    { Nama: 'Melati, Putih', Deskripsi: 'say "hi"', Catatan: 'a;b', Angka: 12345.5 },
    { Nama: 'Mawar', Deskripsi: 'line1\nline2', Catatan: '', Angka: -3 },
    { Nama: '=1+1', Deskripsi: '+6281234567', Catatan: '-5000', Angka: 0 },
    { Nama: '-2+3', Deskripsi: '- bahan alami', Catatan: '-', Angka: '' },
    { Nama: 'Ni Luh Äyu 香 🌺', Deskripsi: '@SUM(A1)', Catatan: 'x', Angka: 7 },
  ]

  it('is byte-for-byte equal to the checked-in golden file the Go importer also parses', () => {
    expect(buildCSV(rows)).toBe(golden)
  })

  it('starts with a BOM and joins records with CRLF', () => {
    const csv = buildCSV(rows)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.split('\r\n')).toHaveLength(rows.length + 1)
  })

  it('quotes semicolons and carriage returns too', () => {
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('a\rb')).toBe('"a\rb"')
  })
})

describe('XLSX never writes formula cells (A39)', () => {
  it('keeps a formula-looking string as a plain text cell with no f key', () => {
    vi.mocked(XLSX.writeFile).mockClear()
    exportToXLSX([{ A: '=SUM(A1)', B: '@x', C: '-2+3' }], 'f')
    const [book] = vi.mocked(XLSX.writeFile).mock.calls[0]
    for (const addr of ['A2', 'B2', 'C2']) {
      expect(book.Sheets.Data[addr].t).toBe('s')
      expect(book.Sheets.Data[addr].f).toBeUndefined()
    }
  })
})

describe('csvCell placeholder signs', () => {
  it('leaves a lone dash or sign unprefixed (empty-cell placeholder)', () => {
    for (const t of ['-', '+', '–', '—', '−']) expect(csvCell(t)).toBe(t)
  })
  it('still prefixes real triggers and sign-led text', () => {
    for (const t of ['=', '@', '-1+2', '+cmd', '--', '-A1']) expect(csvCell(t)).toBe(`'${t}`)
  })
  it('round trips: stripping exactly one leading apostrophe restores the original', () => {
    for (const t of ['-', '=1+1', '-1+2', '+cmd']) expect(csvCell(t).replace(/^'/, '')).toBe(t)
  })
})
