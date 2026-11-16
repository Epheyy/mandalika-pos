// Differential tests: the Standar layout rendered by the block renderer must equal the frozen
// buildReceiptV1 byte for byte, across the flag matrix, the data cases and seeded random receipts.
// (The hex goldens live in ../escpos.unchanged.test.ts.)

import { describe, it, expect } from 'vitest'
import { RECEIPT_FLAG_KEYS } from '@mandalika/types'
import { buildReceiptV1 } from '../__legacy__/buildReceiptV1'
import { buildReceipt } from '../escpos'
import type { ReceiptData } from './data'
import { DATA_CASES, FIXED_DATE, type ReceiptSettings } from './fixtures'
import type { ReceiptLayout } from './layout'
import { LockedBlockError, receiptBytes, renderReceipt } from './render'
import { EscPosSink } from './sink'
import { standarLayout } from './standar'

const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')

const HEADER_FOOTER: Array<[string, string]> = [['', ''], ['TOKO MANDALIKA', ''], ['', 'Terima kasih'], ['TOKO MANDALIKA', 'Terima kasih']]

function settingsFor(mask: number, headerText: string, footerText: string): ReceiptSettings {
  const s: Record<string, unknown> = { headerText, footerText }
  RECEIPT_FLAG_KEYS.forEach((k, i) => { s[k] = (mask & (1 << i)) !== 0 })
  return s as ReceiptSettings
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('Standar equals the frozen legacy receipt', () => {
  it('all 256 flag combinations x header/footer x every data case x reprint on/off', () => {
    let compared = 0
    for (let mask = 0; mask < 256; mask++) {
      for (const [h, f] of HEADER_FOOTER) {
        const settings = settingsFor(mask, h, f)
        for (const [name, data] of Object.entries(DATA_CASES)) {
          for (const reprint of [false, true]) {
            const want = hex(buildReceiptV1(data, settings, reprint))
            const got = hex(receiptBytes(standarLayout(settings), data, { reprint }))
            if (got !== want) throw new Error(`mismatch: mask=${mask} header="${h}" footer="${f}" case=${name} reprint=${reprint}`)
            expect(hex(buildReceipt(data, settings, reprint))).toBe(want)
            compared++
          }
        }
      }
    }
    expect(compared).toBe(256 * 4 * Object.keys(DATA_CASES).length * 2)
  }, 120_000)

  const SEED = 20261113
  const NAMES = ['Parfum', 'Bunga · Melati', 'Café ☺', 'Nama barang yang sangat panjang sekali sampai harus dipotong di baris kedua ya',
    'x'.repeat(80), 'PI·HOLY SWEET', '']
  const pick = <T,>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)]!
  const int = (r: () => number, max: number): number => Math.floor(r() * (max + 1))

  function randomData(r: () => number): ReceiptData {
    const lines = Array.from({ length: int(r, 12) }, () => {
      const qty = 1 + int(r, 9)
      const unit = int(r, 2_000_000)
      const reward = r() < 0.15
      return {
        name: pick(r, NAMES), qty, unitPrice: unit, amount: reward && r() < 0.7 ? 0 : qty * unit,
        ...(r() < 0.4 ? { variant: pick(r, ['50ml', 'Ukuran besar sekali sekali sekali', 'Café']) } : {}),
        ...(reward ? { isReward: true, ...(r() < 0.5 ? { rewardLabel: pick(r, ['promo', 'Hadiah · Mei']) } : {}) } : {}),
        ...(r() < 0.25 ? { pieces: Array.from({ length: 1 + int(r, 3) }, () => pick(r, NAMES)) } : {}),
        ...(r() < 0.25 ? { lineDiscount: { label: pick(r, ['Diskon Bundle', 'Diskon bundle spesial untuk pelanggan setia sekali']), amount: int(r, 100000) } } : {}),
      }
    })
    const itemised = r() < 0.6
    return {
      orderRef: pick(r, ['MND-1', 'abcd1234', 'OFFLINE-0123456789ab']), pending: r() < 0.3, dateTime: new Date(FIXED_DATE.getTime() + int(r, 1e9)),
      lines, subtotal: int(r, 5_000_000), discountAmount: int(r, 100000),
      ...(itemised ? { discounts: Array.from({ length: int(r, 5) }, () => ({ label: pick(r, ['Promo', 'Kode MEI25', 'Diskon manual untuk pelanggan setia yang sangat lama']), amount: int(r, 50000) })) } : {}),
      ...(r() < 0.3 ? { surcharge: r() < 0.5 ? null : int(r, 5000) } : {}),
      ...(r() < 0.3 ? { pointsRedeemed: r() < 0.3 ? null : { points: int(r, 500), amount: int(r, 50000) } } : {}),
      ...(r() < 0.3 ? { rounding: r() < 0.2 ? null : int(r, 1000) - 500 } : {}),
      taxAmount: int(r, 20000), total: int(r, 5_000_000), paymentLabel: pick(r, ['Tunai', 'QRIS', 'Debit BCA']), amountPaid: int(r, 6_000_000),
      ...(r() < 0.3 ? { tenders: Array.from({ length: 1 + int(r, 2) }, () => ({ label: pick(r, ['Tunai', 'QRIS']), amount: int(r, 500000), ...(r() < 0.5 ? { reference: pick(r, ['1234', 'QR-20260529-ABCDEF-123456789']) } : {}) })) } : {}),
      change: int(r, 100000) * (r() < 0.3 ? 0 : 1),
      customerName: r() < 0.5 ? null : pick(r, ['Budi', 'Nama pelanggan yang sangat sangat panjang sekali sekali', 'Café']),
      customerPhone: r() < 0.5 ? null : '08123456789',
      cashierName: pick(r, ['Sari', 'Kasir dengan nama panjang sekali sekali sekali', '']),
      ...(r() < 0.25 ? { replacesOrderRef: pick(r, ['MND-1', 'x'.repeat(40)]) } : {}),
      ...(r() < 0.25 ? { correctionAmount: r() < 0.2 ? 0 : int(r, 60000) - 30000 } : {}),
    }
  }

  it(`2,000 seeded random receipts (seed ${SEED}) match`, () => {
    const r = rng(SEED)
    for (let i = 0; i < 2000; i++) {
      const data = randomData(r)
      const s: Record<string, unknown> = {
        headerText: r() < 0.5 ? '' : pick(r, ['TOKO', 'Header yang cukup panjang sekali untuk uji']),
        footerText: r() < 0.5 ? '' : pick(r, ['Terima kasih', 'Footer yang cukup panjang sekali untuk uji coba ya']),
      }
      for (const k of RECEIPT_FLAG_KEYS) { const v = r(); s[k] = v < 0.4 ? true : v < 0.8 ? false : v < 0.9 ? null : undefined }
      const settings = s as ReceiptSettings
      const reprint = r() < 0.4
      const want = hex(buildReceiptV1(data, settings, reprint))
      const got = hex(receiptBytes(standarLayout(settings), data, { reprint }))
      if (got !== want) throw new Error(`random case ${i} differs (seed ${SEED})`)
    }
  })
})

describe('block failures', () => {
  const settings = { headerText: 'TOKO', footerText: 'Terima kasih' } as ReceiptSettings
  const data = DATA_CASES.plain!

  it('an unlocked block that throws is skipped and reported; a throwing items block throws LockedBlockError', () => {
    const base = standarLayout(settings)
    const badData = { ...data, get dateTime(): Date { throw new Error('boom') } } as ReceiptData
    // The top transaction block reads dateTime: it is unlocked, so it is skipped and reported.
    const reported: string[] = []
    const sink = new EscPosSink()
    renderReceipt(base, badData, sink, { onBlockError: (id) => reported.push(id) })
    expect(reported).toEqual(['std-tx-top'])
    // A skipped block leaves no partial bytes: same as rendering with the block disabled.
    const disabled = { ...base, blocks: base.blocks.map((b) => (b.id === 'std-tx-top' ? { ...b, enabled: false } : b)) } as ReceiptLayout
    expect(hex(sink.done())).toBe(hex(receiptBytes(disabled, data)))

    const brokenLines = { ...data, get lines(): ReceiptData['lines'] { throw new Error('items boom') } } as ReceiptData
    expect(() => receiptBytes(base, brokenLines)).toThrow(LockedBlockError)
    try { receiptBytes(base, brokenLines) } catch (e) { expect((e as LockedBlockError).blockId).toBe('std-items') }
  })

  it('a disabled locked block still prints (locked blocks cannot be switched off)', () => {
    const base = standarLayout(settings)
    const layout = { ...base, blocks: base.blocks.map((b) => (b.type === 'items' ? { ...b, enabled: false } : b)) } as unknown as ReceiptLayout
    expect(hex(receiptBytes(layout, data))).toBe(hex(receiptBytes(base, data)))
  })

  it('buildReceipt keeps its signature', () => {
    const f: (d: ReceiptData, s: ReceiptSettings, reprint?: boolean) => Uint8Array = buildReceipt
    expect(f(data, settings)).toBeInstanceOf(Uint8Array)
  })
})
