import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allocateNet, refundAmountForUnits, refundCum, type AllocComponent, type AllocLine } from './allocateNet'

// Shared with the Go allocator: backend/internal/service/testdata/allocate_golden.json. Changing a vector
// there without the twin (or the other way round) fails one of the two suites on purpose.
const GOLDEN = new URL('../../../../backend/internal/service/testdata/allocate_golden.json', import.meta.url)

interface AllocationCase {
  name: string
  lines: AllocLine[]
  components: AllocComponent[]
  total: number
  ok: boolean
  expectedNets?: number[]
}
interface RefundCase {
  name: string
  net: number
  qty: number
  steps: number[]
  expectedAmounts: number[]
}
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { allocations: AllocationCase[]; refunds: RefundCase[] }

describe('allocateNet golden vectors (Go parity)', () => {
  it('loads a non-trivial fixture', () => {
    expect(golden.allocations.length).toBeGreaterThanOrEqual(15)
    expect(golden.refunds.length).toBeGreaterThanOrEqual(5)
  })

  for (const c of golden.allocations) {
    it(`allocation: ${c.name}`, () => {
      const nets = allocateNet({ lines: c.lines, components: c.components, total: c.total })
      if (!c.ok) {
        expect(nets).toBeNull()
        return
      }
      expect(nets).toEqual(c.expectedNets)
      // The invariants every consumer relies on, independent of the vector.
      expect(nets!.reduce((a, b) => a + b, 0)).toBe(c.total)
      expect(nets!.every((v) => v >= 0)).toBe(true)
    })
  }

  for (const r of golden.refunds) {
    it(`refund amounts: ${r.name}`, () => {
      let prior = 0
      const got = r.steps.map((k) => {
        const amount = refundAmountForUnits(r.net, r.qty, prior, k)
        prior += k
        return amount
      })
      expect(got).toEqual(r.expectedAmounts)
      if (prior >= r.qty) expect(got.reduce((a, b) => a + b, 0)).toBe(r.net)
    })
  }
})

describe('allocateNet edge rules', () => {
  it('rejects a component that names a line outside the sale', () => {
    expect(allocateNet({ lines: [{ lineNo: 0, base: 100 }], components: [{ amount: 10, eligible: [3] }], total: 90 })).toBeNull()
  })
  it('rejects negative or fractional input instead of guessing', () => {
    expect(allocateNet({ lines: [{ lineNo: 0, base: -1 }], components: [], total: 0 })).toBeNull()
    expect(allocateNet({ lines: [{ lineNo: 0, base: 100.5 }], components: [], total: 100 })).toBeNull()
    expect(allocateNet({ lines: [], components: [], total: 0 })).toBeNull()
  })
  it('refundCum never exceeds net and is monotonic', () => {
    for (const [net, qty] of [[100000, 3], [7, 4], [1, 5]] as const) {
      let prev = 0
      for (let n = 0; n <= qty + 1; n++) {
        const v = refundCum(net, qty, n)
        expect(v).toBeGreaterThanOrEqual(prev)
        expect(v).toBeLessThanOrEqual(net)
        prev = v
      }
      expect(refundCum(net, qty, qty)).toBe(net)
    }
  })
})
