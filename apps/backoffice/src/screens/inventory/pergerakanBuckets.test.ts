import { describe, expect, it } from 'vitest'
import { BUCKET_COLUMNS, bucketsReconcile, formatSigned } from './pergerakanBuckets'

const buckets = { masuk: 12, penjualan: -6, refund: 1, transfer: 1, penyesuaian: 7, hadiah: -1 }

describe('pergerakanBuckets', () => {
  it('lists the six buckets in the auditor order', () => {
    expect(BUCKET_COLUMNS.map((c) => c.key)).toEqual(['masuk', 'penjualan', 'refund', 'transfer', 'penyesuaian', 'hadiah'])
  })

  it('formats signed quantities', () => {
    expect([formatSigned(5), formatSigned(-3), formatSigned(0)]).toEqual(['+5', '-3', '0'])
  })

  it('reconciles opening + buckets with closing', () => {
    expect(bucketsReconcile({ opening: 0, closing: 14, buckets })).toBe(true)
    expect(bucketsReconcile({ opening: 0, closing: 15, buckets })).toBe(false)
  })
})
