// Byte-for-byte guard. The .hex goldens were captured from the escpos.ts at origin/prod-hardening e61e6937
// (before the receipt-designer refactor). They must never change in Phase 1.
// To (re)capture deliberately: UPDATE_GOLDEN=1 corepack pnpm --filter @mandalika/printer test -- unchanged

import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReceipt, buildRecap, buildTandaTerima, buildVoidSlip } from './escpos'
import { buildReceiptV1 } from './__legacy__/buildReceiptV1'
import { RECEIPT_CASES, RECAP, TANDA_TERIMA, VOID_SLIP, FIXED_DATE, type ReceiptSettings } from './receipt/fixtures'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'receipt', '__golden__')
const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')

function golden(name: string, actual: Uint8Array): string {
  const file = join(GOLDEN_DIR, `${name}.hex`)
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(file, hex(actual) + '\n')
  }
  if (!existsSync(file)) throw new Error(`missing golden ${name}.hex (capture with UPDATE_GOLDEN=1)`)
  return readFileSync(file, 'utf8').trim()
}

afterEach(() => vi.useRealTimers())

describe('printed bytes are unchanged', () => {
  for (const c of RECEIPT_CASES) {
    it(`receipt golden "${c.name}": buildReceipt and the frozen buildReceiptV1 match the hex`, () => {
      const want = golden(`receipt-${c.name}`, buildReceipt(c.data, c.settings, c.reprint))
      expect(hex(buildReceipt(c.data, c.settings, c.reprint))).toBe(want)
      expect(hex(buildReceiptV1(c.data, c.settings, c.reprint))).toBe(want)
    })
  }

  it('buildRecap bytes are unchanged', () => {
    const settings = { headerText: 'Mandalika', footerText: 'Terima kasih' } as ReceiptSettings
    expect(hex(buildRecap(RECAP, settings))).toBe(golden('recap', buildRecap(RECAP, settings)))
  })

  it('buildTandaTerima bytes are unchanged (clock pinned)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_DATE)
    const settings = { footerText: 'Terima kasih' } as ReceiptSettings
    expect(hex(buildTandaTerima(TANDA_TERIMA, settings, true))).toBe(golden('tandaterima', buildTandaTerima(TANDA_TERIMA, settings, true)))
  })

  it('buildVoidSlip (DIBATALKAN) bytes are unchanged', () => {
    expect(hex(buildVoidSlip(VOID_SLIP))).toBe(golden('voidslip', buildVoidSlip(VOID_SLIP)))
  })
})
