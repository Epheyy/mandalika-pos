import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { redeemPoints } from './pricing'

type Case = { name: string; requested: number; available: number; rate: number; total: number; expected: { points: number; amount: number } }
// Same fixture file is read by Go points_redemption_golden_test.go.
const golden: Case[] = JSON.parse(readFileSync(new URL('../../../../backend/internal/service/testdata/points_redemption_golden.json', import.meta.url), 'utf8'))

describe('points redemption golden vectors (shared with Go RedeemPoints)', () => {
  it('pins the case count', () => expect(golden).toHaveLength(17))
  it.each(golden)('$name', ({ requested, available, rate, total, expected }) => {
    expect(redeemPoints(requested, available, rate, total)).toEqual(expected)
  })
})
