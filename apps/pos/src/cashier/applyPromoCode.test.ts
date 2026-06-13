import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { decideApplyCode } from './promoValidate'

type DiscountCode = components['schemas']['DiscountCode']

const NOW = new Date('2026-06-13T07:30:00Z') // 14:30 WIB Sat
const ctx = { now: NOW, outletId: 'outlet-a', subtotal: 100000 }

function code(partial: Partial<DiscountCode>): DiscountCode {
  return {
    id: 'c1', code: 'SAVE', type: 'fixed', value: 1000,
    usageCount: 0, isActive: true, createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

describe('decideApplyCode', () => {
  it('rejects an unknown code with a not-found reason', () => {
    const r = decideApplyCode('NOPE', [code({ code: 'SAVE' })], ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('Kode tidak ditemukan')
  })

  it('rejects an inactive code as not found', () => {
    const r = decideApplyCode('SAVE', [code({ code: 'SAVE', isActive: false })], ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('Kode tidak ditemukan')
  })

  it('rejects a valid-but-ineligible code with the violation reason', () => {
    const r = decideApplyCode('SAVE', [code({ code: 'SAVE', minPurchase: 150000 })], ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('Belum memenuhi minimum belanja')
  })

  it('accepts an eligible code (case-insensitive match)', () => {
    const r = decideApplyCode('save', [code({ code: 'SAVE', value: 5000 })], ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.code).toEqual({ code: 'SAVE', value: 5000, type: 'fixed' })
  })
})
