import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveReceiptFlags } from '@mandalika/types'
import { standarLayout } from '@mandalika/printer/render'
import { DEFAULT_SETTINGS, buildSaveBody, diffSettings, normalize } from './settingsDiff'
import { BlockEditor } from './struk/BlockEditor'

// The receipt flags (showTax, showCashier, ...) are now shown by the designer's block editors, built from Standar.
// Live shape found by QA R11: only some keys stored.
const STORED = { copies: 1, headerText: '', footerText: '', showCashier: false, showTax: false }
const serverWith = (receipt: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, receipt }) as never

// label shown in the UI -> [key, what an absent/null key means on paper]
const CONTROLS = {
  'Nomor pesanan': ['showOrderNumber', true],
  'Dicetak oleh': ['showCashier', false],
  'Nama Pelanggan': ['showCustomerName', true],
  'Nomor Telepon': ['showCustomerPhone', false],
  'Tampilkan Pajak': ['showTax', false],
  'Tampilkan Diskon': ['showDiscount', true],
  'Tampilkan Subtotal': ['showSubtotal', true],
} as const
const STATES = ['absent', 'null', 'false', 'true'] as const

/** Every block editor of Standar for these settings, as markup. */
const editorsOn = (s: ReturnType<typeof normalize>): string =>
  standarLayout(s.receipt).blocks
    .map((b) => renderToStaticMarkup(<BlockEditor block={b} onChange={() => {}} />))
    .join('')

/** Whether the control named `label` is on in any editor: a switch (aria-checked) or a checkbox (checked). */
const controlOn = (html: string, label: string): boolean => {
  const tags = [...html.matchAll(new RegExp(`<(?:button|input)[^>]*aria-label="${label}"[^>]*>`, 'g'))].map((m) => m[0])
  expect(tags.length, label).toBeGreaterThan(0)
  return tags.some((t) => t.includes('aria-checked="true"') || /\schecked(=""|\s|>)/.test(t))
}

describe('F35 the designer reads each flag the way the printer does', () => {
  for (const [label, [key, dflt]] of Object.entries(CONTROLS)) {
    for (const st of STATES) {
      const want = st === 'true' ? true : st === 'false' ? false : dflt
      it(`${key} ${st}: control is ${want ? 'ON' : 'OFF'}, no unsaved change on open`, () => {
        const stored = st === 'absent' ? { ...STORED } : { ...STORED, [key]: st === 'null' ? null : st === 'true' }
        if (st === 'absent') delete (stored as Record<string, unknown>)[key]
        const s = normalize(serverWith(stored))
        expect(controlOn(editorsOn(s), label)).toBe(want)
        expect(diffSettings(normalize(serverWith(stored)), s)).toEqual([])
      })
    }
  }

  it('the payment editor has no Kembalian switch: change is locked on', () => {
    const html = editorsOn(normalize(serverWith(STORED)))
    expect(html).not.toContain('Kembalian"')
    expect(html).toContain('Pembayaran dan kembalian selalu dicetak.')
  })

  it('the live QA settings: customer phone and discount agree with the paper (phone OFF, discount ON)', () => {
    const s = normalize(serverWith(STORED))
    const html = editorsOn(s)
    expect(controlOn(html, 'Nomor Telepon')).toBe(false)
    expect(controlOn(html, 'Tampilkan Diskon')).toBe(true)
    expect(controlOn(html, 'Tampilkan Pajak')).toBe(false)
    expect(resolveReceiptFlags(s.receipt).showCustomerPhone).toBe(false)
  })

  it('a partial stored object is not deep-merged with the all-ON defaults', () => {
    expect(normalize(serverWith(STORED)).receipt.showCustomerPhone).toBe(false)
  })

  it('saving OFF changes only that flag; every other flag keeps what the paper already did', () => {
    const fresh = normalize(serverWith(STORED))
    const draft = { ...fresh, receipt: { ...fresh.receipt, showChange: false } }
    const changes = diffSettings(fresh, draft)
    expect(changes.map((c) => c.path)).toEqual(['receipt.showChange'])
    const body = buildSaveBody(serverWith(STORED), fresh, draft, changes)
    const before = resolveReceiptFlags(STORED as never)
    expect(resolveReceiptFlags(body.receipt)).toEqual({ ...before, showChange: false })
    // Non-flag receipt fields and non-receipt settings are untouched.
    expect(body.receipt.copies).toBe(1)
    expect(body.taxRate).toBe(fresh.taxRate)
  })

  it('an empty receipt object resolves to the printer defaults', () => {
    expect(normalize(serverWith({ headerText: '', footerText: '' })).receipt.showCustomerPhone).toBe(false)
  })

  for (const missing of [null, undefined]) {
    it(`no receipt object (${String(missing)}): controls equal the printer defaults, no unsaved change on open`, () => {
      const raw = { ...DEFAULT_SETTINGS, receipt: missing } as never
      const s = normalize(raw)
      const html = editorsOn(s)
      for (const [label, [key, dflt]] of Object.entries(CONTROLS)) {
        expect(controlOn(html, label), key).toBe(dflt)
      }
      expect(diffSettings(normalize(raw), s)).toEqual([])
    })
  }
})
