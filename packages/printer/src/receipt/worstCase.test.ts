import { describe, it, expect } from 'vitest'
import { MAX_RECEIPT_PAYLOAD_BYTES } from '../linkChoice'
import { receiptBytes } from './render'
import { validateTemplate } from './validate'
import { WORST_CASE_SALE, worstCaseLayout } from './worstCase'

describe('worst-case receipt', () => {
  it('is a valid template at the limits', () => {
    const l = worstCaseLayout()
    expect(l.blocks).toHaveLength(30)
    expect(validateTemplate({ name: 'Terberat', paperWidth: l.paperWidth, blocks: l.blocks })).toEqual([])
    expect(l.blocks.filter((b) => b.type === 'image')).toHaveLength(2)
    expect(l.blocks.filter((b) => b.type === 'qr')).toHaveLength(2)
  })

  it('receiptBytes(worstCaseLayout(), WORST_CASE_SALE) <= MAX_RECEIPT_PAYLOAD_BYTES at 58 and 80mm', () => {
    for (const paperWidth of [58, 80] as const) {
      const n = receiptBytes({ ...worstCaseLayout(), paperWidth }, WORST_CASE_SALE).length
      expect(n, `${paperWidth}mm`).toBeLessThanOrEqual(MAX_RECEIPT_PAYLOAD_BYTES)
    }
  })

  it('MAX_RECEIPT_PAYLOAD_BYTES is the measured worst case rounded up to the next 1,000', () => {
    const worst = Math.max(...([58, 80] as const).map((w) => receiptBytes({ ...worstCaseLayout(), paperWidth: w }, WORST_CASE_SALE).length))
    expect(MAX_RECEIPT_PAYLOAD_BYTES).toBe(Math.ceil(worst / 1000) * 1000)
  })
})
