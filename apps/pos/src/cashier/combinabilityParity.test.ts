import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { cashierReducer, CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'
import { decideApplyCode } from './promoValidate'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']
interface Item { source: 'bundle_discount' | 'unlinked_code' | 'promotion'; combinable: boolean }
interface Case { name: string; items: Item[]; allowed: boolean }

// Same fixture file is read by Go TestCombinabilityGolden. Never edit it to match an engine.
const cases = JSON.parse(readFileSync(new URL('../../../../backend/internal/service/testdata/combinability_golden.json', import.meta.url), 'utf8')) as Case[]

const ctx = { now: new Date('2026-09-20T05:00:00Z'), outletId: 'outlet', subtotal: 100000, hasCustomer: false }

function applyAll(items: Item[]): CashierState {
  let state = CASHIER_INITIAL_STATE
  items.forEach((it, i) => {
    if (it.source === 'unlinked_code') {
      const dc = { id: `c${i}`, code: `CODE${i}`, type: 'fixed', value: 1000, combinable: it.combinable, usageCount: 0, isActive: true, createdAt: '' } as DiscountCode
      const d = decideApplyCode(dc.code, [dc], ctx, [])
      if (!d.ok) throw new Error(d.reason)
      state = cashierReducer(state, { type: 'APPLY_PROMO_CODE', code: d.code, combinable: !!d.code.combinable })
      return
    }
    const promotion = {
      id: `p${i}`, name: `p${i}`, isActive: true, createdAt: '', combinable: it.combinable,
      ...(it.source === 'bundle_discount'
        ? { type: 'bundle_discount', value: 10, bundleDiscountConfig: { kind: 'percentage', lines: [], sizes: [] } }
        : { type: 'percentage', value: 5 }),
    } as Promotion
    state = cashierReducer(state, { type: 'APPLY_PROMOTION', promotion })
  })
  return state
}

it('combinability golden fixture count is pinned', () => expect(cases).toHaveLength(6))

describe('shared Go and TypeScript combinability matrix', () => {
  it.each(cases)('$name', (c) => {
    for (const items of [c.items, [...c.items].reverse()]) {
      const s = applyAll(items)
      const kept = s.appliedPromotions.length + s.appliedPromoCodes.length
      // Allowed sets keep every discount; a refused set can only be built by evicting down to the last one.
      expect(kept).toBe(c.allowed ? items.length : 1)
    }
  })
})
