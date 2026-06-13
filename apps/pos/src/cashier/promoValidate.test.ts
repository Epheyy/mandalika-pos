import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import {
  validatePromo,
  validateCode,
  violationMessage,
  type Violation,
} from './promoValidate'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

// 2026-06-13 14:30 WIB == 2026-06-13 07:30 UTC. Saturday (weekday 6).
// Constructed as a UTC instant so the test is deterministic on any machine zone.
const NOW = new Date('2026-06-13T07:30:00Z')
const baseCtx = { now: NOW, outletId: 'outlet-a', subtotal: 100000 }

function promo(partial: Partial<Promotion>): Promotion {
  return {
    id: 'p1',
    name: 'P',
    type: 'fixed',
    value: 1000,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}
function code(partial: Partial<DiscountCode>): DiscountCode {
  return {
    id: 'c1',
    code: 'X',
    type: 'fixed',
    value: 1000,
    usageCount: 0,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

describe('validatePromo', () => {
  const cases: { name: string; row: Partial<Promotion>; want: Violation[] }[] = [
    { name: 'all empty passes', row: {}, want: [] },
    { name: 'not started', row: { startDate: '2026-06-20' }, want: ['not_started'] },
    { name: 'expired', row: { endDate: '2026-06-01' }, want: ['expired'] },
    { name: 'date window inclusive ok', row: { startDate: '2026-06-13', endDate: '2026-06-13' }, want: [] },
    { name: 'below min', row: { minPurchase: 150000 }, want: ['below_min_purchase'] },
    { name: 'min exact ok', row: { minPurchase: 100000 }, want: [] },
    { name: 'wrong day', row: { activeDays: [1, 2, 3] }, want: ['wrong_day'] },
    { name: 'right day ok', row: { activeDays: [6] }, want: [] },
    { name: 'outside hours', row: { activeFromHour: '09:00', activeToHour: '12:00' }, want: ['outside_hours'] },
    { name: 'inside hours ok', row: { activeFromHour: '09:00', activeToHour: '17:00' }, want: [] },
    { name: 'hour boundary inclusive', row: { activeFromHour: '14:30', activeToHour: '14:30' }, want: [] },
    { name: 'only one hour set = no gate', row: { activeFromHour: '09:00' }, want: [] },
    { name: 'wrong outlet', row: { outletIds: ['outlet-b'] }, want: ['wrong_outlet'] },
    { name: 'right outlet ok', row: { outletIds: ['outlet-a', 'outlet-b'] }, want: [] },
  ]
  for (const tc of cases) {
    it(tc.name, () => {
      expect(validatePromo(promo(tc.row), baseCtx)).toEqual(tc.want)
    })
  }
})

describe('validateCode', () => {
  const cases: { name: string; row: Partial<DiscountCode>; want: Violation[] }[] = [
    { name: 'all empty passes', row: {}, want: [] },
    { name: 'expired', row: { endDate: '2026-06-01' }, want: ['expired'] },
    { name: 'below min', row: { minPurchase: 150000 }, want: ['below_min_purchase'] },
    { name: 'usage limit reached', row: { usageLimit: 2, usageCount: 2 }, want: ['usage_limit_reached'] },
    { name: 'usage under limit ok', row: { usageLimit: 2, usageCount: 1 }, want: [] },
    { name: 'usage limit zero = unlimited', row: { usageLimit: 0, usageCount: 99 }, want: [] },
    { name: 'nil limit = unlimited', row: { usageCount: 99 }, want: [] },
  ]
  for (const tc of cases) {
    it(tc.name, () => {
      expect(validateCode(code(tc.row), baseCtx)).toEqual(tc.want)
    })
  }
})

describe('violationMessage', () => {
  const all: Violation[] = [
    'not_started', 'expired', 'below_min_purchase',
    'wrong_day', 'outside_hours', 'wrong_outlet', 'usage_limit_reached',
  ]
  it('returns a non-empty Indonesian string for every violation', () => {
    for (const v of all) {
      expect(violationMessage(v).length).toBeGreaterThan(0)
    }
  })
})
