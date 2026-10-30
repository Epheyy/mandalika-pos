import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allocateTenders, cashPredicate, tenderStructureError, type TenderLine, type TenderMode } from './tenderSplit'

// Shared with the Go allocator: backend/internal/service/testdata/tender_golden.json. A vector changed on one side
// without the twin fails one of the two suites on purpose.
const GOLDEN = new URL('../../../../backend/internal/service/testdata/tender_golden.json', import.meta.url)

interface ExpectedLine { seq: number; method: string; amount: number; tendered: number; change: number; reference?: string }
interface AllocationCase {
  name: string
  mode: TenderMode
  due: number
  lines: TenderLine[]
  reject?: boolean
  expected?: { paymentMethod: string; amountPaid: number; change: number; reason: string; lines: ExpectedLine[] }
}
interface StructuralCase { name: string; paymentMethod: string; reject: boolean; tenders?: unknown }

const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { allocations: AllocationCase[]; structural: StructuralCase[] }
const isCash = cashPredicate([]) // the default rule: ids cash/tunai

describe('tenderSplit golden vectors (Go parity)', () => {
  it('loads a non-trivial fixture', () => {
    expect(golden.allocations.length).toBeGreaterThanOrEqual(20)
    expect(golden.structural.length).toBeGreaterThanOrEqual(20)
  })

  for (const c of golden.allocations) {
    it(`allocation: ${c.name}`, () => {
      const r = allocateTenders(c.due, c.lines, isCash, c.mode)
      if (c.reject) {
        expect(r.ok).toBe(false)
        return
      }
      expect(r.ok).toBe(true)
      if (!r.ok || !c.expected) return
      const s = r.settlement
      expect(s.paymentMethod).toBe(c.expected.paymentMethod)
      expect(s.amountPaid).toBeCloseTo(c.expected.amountPaid, 2)
      expect(s.change).toBeCloseTo(c.expected.change, 2)
      expect(s.reason).toBe(c.expected.reason)
      expect(s.lines).toHaveLength(c.expected.lines.length)
      c.expected.lines.forEach((e, i) => {
        const l = s.lines[i]!
        expect(l.seq).toBe(e.seq)
        expect(l.method).toBe(e.method)
        expect(l.amount).toBeCloseTo(e.amount, 2)
        expect(l.tendered).toBeCloseTo(e.tendered, 2)
        expect(l.change).toBeCloseTo(e.change, 2)
        expect(l.reference).toBe(e.reference)
      })
      // The invariant every reader relies on: the applied amounts add up to the due total.
      const applied = s.lines.reduce((sum, l) => sum + Math.round(l.amount * 100), 0)
      expect(applied).toBe(Math.round(c.due * 100))
    })
  }

  // The structural cases are request-level: the TS twin checks the lines of an array-shaped `tenders`.
  for (const c of golden.structural) {
    if (!Array.isArray(c.tenders)) continue
    it(`structural: ${c.name}`, () => {
      const lines = (c.tenders as { method: string; amount?: number; reference?: string }[]).map((t) => ({ ...t, amount: t.amount as number }))
      const missingAmount = lines.some((l) => typeof l.amount !== 'number')
      const err = missingAmount ? 'amount' : tenderStructureError(lines)
      expect(err !== null).toBe(c.reject)
    })
  }
})
