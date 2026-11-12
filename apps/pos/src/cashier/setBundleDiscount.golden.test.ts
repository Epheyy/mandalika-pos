import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { bestBundleDiscount, splitBundleAmount, type Basis } from './setBundles'

type Promotion = components['schemas']['Promotion']

// Shared with Go (`bestBundleDiscount` + `bundles.Split`): backend/internal/service/testdata/set_bundle_discount_golden.json.
const GOLDEN = new URL('../../../../backend/internal/service/testdata/set_bundle_discount_golden.json', import.meta.url)

interface GoldenPromo { id: string; kind: 'percentage' | 'fixed'; value: number; lines: string[]; sizes: string[] }
interface Case {
  name: string
  price: number
  line: string
  size: string
  basis: Basis
  promos: GoldenPromo[]
  expected: { discount: number; promotionId: string; shares: [number, number, number]; discShares: [number, number, number] }
}
const cases = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Case[]

const asPromo = (p: GoldenPromo): Promotion =>
  ({
    id: p.id, name: p.id, type: 'bundle_discount', value: p.value, isActive: true, combinable: true, createdAt: '',
    bundleDiscountConfig: { kind: p.kind, lines: p.lines, sizes: p.sizes },
  }) as Promotion

describe('Diskon Bundle golden matches Go', () => {
  it('loads the fixture', () => expect(cases.length).toBeGreaterThanOrEqual(7))
  it.each(cases)('$name', (c) => {
    const { amount, promotionId } = bestBundleDiscount(c.price, c.line, c.size, c.basis, c.promos.map(asPromo))
    expect(amount).toBe(c.expected.discount)
    expect(promotionId ?? '').toBe(c.expected.promotionId)
    expect(splitBundleAmount(c.price - amount, c.basis)).toEqual(c.expected.shares)
    expect(amount > 0 ? splitBundleAmount(amount, c.basis) : [0, 0, 0]).toEqual(c.expected.discShares)
  })
})
