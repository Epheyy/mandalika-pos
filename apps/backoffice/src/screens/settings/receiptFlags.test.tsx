import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveReceiptFlags } from '@mandalika/types'
import { DEFAULT_SETTINGS, buildSaveBody, diffSettings, normalize } from './settingsDiff'
import { TransaksiSection } from './TransaksiSection'

// Live shape found by QA R11: only some keys stored.
const STORED = { copies: 1, headerText: '', footerText: '', showCashier: false, showTax: false }
const serverWith = (receipt: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, receipt }) as never

// label shown in the UI -> [key, what an absent/null key means on paper]
const SWITCHES = {
  'Nomor pesanan': ['showOrderNumber', true],
  'Dicetak oleh': ['showCashier', false],
  'Nama Pelanggan': ['showCustomerName', true],
  'Nomor Telepon': ['showCustomerPhone', false],
  'Tampilkan Pajak': ['showTax', false],
  'Tampilkan Diskon': ['showDiscount', true],
  'Tampilkan Subtotal': ['showSubtotal', true],
  'Tampilkan Kembalian': ['showChange', true],
} as const
const STATES = ['absent', 'null', 'false', 'true'] as const

const renderOn = (s: ReturnType<typeof normalize>) =>
  renderToStaticMarkup(<TransaksiSection s={s} setS={() => {}} newPay="" setNewPay={() => {}} changed={new Set()} changes={[]} />)
const switchOn = (html: string, label: string) => new RegExp(`aria-checked="(true|false)"[^>]*aria-label="${label}"`).exec(html)![1] === 'true'

describe('F35 Backoffice switches read each flag the way the printer does', () => {
  for (const [label, [key, dflt]] of Object.entries(SWITCHES)) {
    for (const st of STATES) {
      const want = st === 'true' ? true : st === 'false' ? false : dflt
      it(`${key} ${st}: switch is ${want ? 'ON' : 'OFF'}, no unsaved change on open`, () => {
        const stored = st === 'absent' ? { ...STORED } : { ...STORED, [key]: st === 'null' ? null : st === 'true' }
        // showCashier/showTax live in STORED as false; an explicit state overrides, 'absent' removes them
        if (st === 'absent') delete (stored as Record<string, unknown>)[key]
        const s = normalize(serverWith(stored))
        expect(switchOn(renderOn(s), label)).toBe(want)
        expect(diffSettings(normalize(serverWith(stored)), s)).toEqual([])
      })
    }
  }

  it('the live QA settings: customer phone and discount agree with the paper (phone OFF, discount ON)', () => {
    const s = normalize(serverWith(STORED))
    const html = renderOn(s)
    expect(switchOn(html, 'Nomor Telepon')).toBe(false)
    expect(switchOn(html, 'Tampilkan Diskon')).toBe(true)
    expect(switchOn(html, 'Tampilkan Pajak')).toBe(false)
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

  it('an empty receipt object resolves to the printer defaults; a missing one keeps the old all-ON fallback', () => {
    expect(normalize(serverWith({ headerText: '', footerText: '' })).receipt.showCustomerPhone).toBe(false)
    expect(normalize({ ...DEFAULT_SETTINGS, receipt: undefined } as never).receipt).toEqual(DEFAULT_SETTINGS.receipt)
  })
})
