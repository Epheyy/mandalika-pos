import { describe, it, expect, vi } from 'vitest'
import type { BundleCatalog, BundleSettings } from '@mandalika/api'
import { aromaRows, formProblems, formToInput, saveBundleSettings, settingsToForm } from './bundleSettings'

const EXT = 'EXTRAIT DE PARFUM'
const PI = 'PARFUM INTENSE'
const lines = [
  { line: EXT, label: 'Extrait', short: 'EXT' },
  { line: PI, label: 'Parfum Intense', short: 'PI' },
]

const champion: BundleSettings = {
  standard: [
    { size: '100ml', price: 650000 },
    { size: '110ml', price: 725000 },
    { size: '120ml', price: 795000 },
  ],
  linePrices: [{ line: EXT, size: '120ml', price: 850000 }],
  lines,
}

const offer = (line: string, short: string, size: string, price: number) => ({
  line, lineLabel: short, lineShort: short, size, price,
  largeVariantSize: size, atomizerVariantSize: '10ml', vialVariantSize: '2ml',
})

const catalog: BundleCatalog = {
  lines,
  pieces: [],
  products: [
    { productId: 'c', productName: 'CHAMPION', offers: [offer(EXT, 'EXT', '120ml', 850000), offer(PI, 'PI', '120ml', 795000)], missing: [] },
    {
      productId: 'b', productName: 'ONLY THE BRAVE',
      offers: [offer(EXT, 'EXT', '120ml', 850000)],
      missing: [{ line: PI, size: '120ml', reason: 'no_vial', text: '2ml Parfum Intense belum ada' }],
    },
    {
      productId: 'n', productName: 'NO1', offers: [],
      missing: [
        { line: EXT, size: '120ml', reason: 'no_atomizer', text: 'atomizer belum ada' },
        { line: PI, size: '120ml', reason: 'no_atomizer', text: 'atomizer belum ada' },
      ],
    },
  ],
}

describe('bundle settings form', () => {
  it('settingsToForm/formToInput round-trip the CHAMPION example', () => {
    const f = settingsToForm(champion)
    expect(f.standard).toEqual({ '100ml': '650000', '110ml': '725000', '120ml': '795000' })
    expect(f.lines[EXT]['120ml']).toBe('850000')
    expect(f.lines[PI]['120ml']).toBe('')
    expect(formToInput(f)).toEqual({ standard: champion.standard, linePrices: champion.linePrices })
  })

  it('formToInput drops empty line prices', () => {
    const f = settingsToForm(champion)
    f.lines[EXT]['120ml'] = ''
    expect(formToInput(f).linePrices).toEqual([])
  })

  it('formToInput reads Rp-style text', () => {
    const f = settingsToForm(champion)
    f.standard['100ml'] = 'Rp 660.000'
    expect(formToInput(f).standard[0]).toEqual({ size: '100ml', price: 660000 })
  })

  it('settingsToForm of empty settings shows 100ml, 110ml and 120ml standard fields, empty', () => {
    const f = settingsToForm({ standard: [], linePrices: [], lines: [] })
    expect(f.standard).toEqual({ '100ml': '', '110ml': '', '120ml': '' })
    expect(formToInput(f)).toEqual({ standard: [], linePrices: [] })
  })

  it('settingsToForm keeps a stored 130ml standard price after the three defaults', () => {
    const f = settingsToForm({ standard: [{ size: '130ml', price: 900000 }], linePrices: [], lines })
    expect(Object.keys(f.standard)).toEqual(['100ml', '110ml', '120ml', '130ml'])
    expect(f.standard['130ml']).toBe('900000')
    expect(Object.keys(f.lines[EXT])).toEqual(['100ml', '110ml', '120ml', '130ml'])
  })

  it('formProblems reports "Harga lini 110ml butuh harga standar 110ml"', () => {
    const f = settingsToForm(champion)
    f.standard['110ml'] = ''
    f.lines[EXT]['110ml'] = '800000'
    expect(formProblems(f)).toEqual(['Harga lini 110ml butuh harga standar 110ml'])
    expect(formProblems(settingsToForm(champion))).toEqual([])
  })

  it('formProblems reports a zero price', () => {
    const f = settingsToForm(champion)
    f.standard['100ml'] = '0'
    expect(formProblems(f)).toEqual(['Harga bundle harus bilangan bulat > 0'])
  })
})

describe('aromaRows', () => {
  it('lists every product with chips and notes', () => {
    const rows = aromaRows(catalog, 'all')
    expect(rows.map((r) => r.name)).toEqual(['CHAMPION', 'ONLY THE BRAVE', 'NO1'])
    expect(rows[0].offers.map((o) => o.text)).toEqual(['EXT 120ml · Rp 850.000', 'PI 120ml · Rp 795.000'])
    expect(rows[1].notes.map((n) => n.text)).toEqual(['PI: 2ml Parfum Intense belum ada'])
    expect(rows[2].offers).toEqual([])
    expect(rows[2].notes.map((n) => n.text)).toEqual(['atomizer belum ada'])
  })

  it('filter "missing" keeps only NO1 and ONLY THE BRAVE', () => {
    expect(aromaRows(catalog, 'missing').map((r) => r.name)).toEqual(['ONLY THE BRAVE', 'NO1'])
  })
})

describe('saveBundleSettings', () => {
  it('saves through updateBundleSettings with the input the form produces', async () => {
    const api = { updateBundleSettings: vi.fn().mockResolvedValue(undefined) }
    const r = await saveBundleSettings(api, settingsToForm(champion))
    expect(r).toEqual({ ok: true })
    expect(api.updateBundleSettings).toHaveBeenCalledWith({ standard: champion.standard, linePrices: champion.linePrices })
  })

  it('shows the server error text', async () => {
    const api = { updateBundleSettings: vi.fn().mockRejectedValue(new Error('Lini tidak dikenal: GLITTER')) }
    expect(await saveBundleSettings(api, settingsToForm(champion))).toEqual({ ok: false, error: 'Lini tidak dikenal: GLITTER' })
  })

  it('does not call the server while the form has a problem', async () => {
    const api = { updateBundleSettings: vi.fn() }
    const f = settingsToForm(champion)
    f.standard['110ml'] = ''
    f.lines[EXT]['110ml'] = '800000'
    const r = await saveBundleSettings(api, f)
    expect(r).toEqual({ ok: false, error: 'Harga lini 110ml butuh harga standar 110ml' })
    expect(api.updateBundleSettings).not.toHaveBeenCalled()
  })
})
