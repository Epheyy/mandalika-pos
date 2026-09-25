import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { buildTandaTerimaData } from './buildTandaTerimaData'
type Transfer = components['schemas']['Transfer']
describe('received wire nullable letterhead', () => {
  for (const state of ['absent', 'null', 'object'] as const) {
    it(`preserves snapshot and receipt fallback for ${state}`, () => {
      const base = { id: 'owned', transferNo: 'TR-OWNED', tandaTerimaNo: 'TT-OWNED', status: 'completed', source: { kind: 'warehouse', id: 's', name: 'Owned Source' }, dest: { kind: 'outlet', id: 'd', name: 'Owned Dest' }, items: [{ productName: 'Parfum 香', variantSize: '10', sentQty: 2, receivedQty: 2 }], createdAt: '2026-09-25T01:00:00Z', receivedAt: '2026-09-25T02:00:00Z' }
      const value = state === 'object' ? { locationName: 'Outlet', brandName: 'Mändalika 香', addressLines: ['Owned Street'], phone: null } : null
      const wire = JSON.stringify(state === 'absent' ? base : { ...base, receiverLetterhead: value, senderLetterhead: value })
      const decoded: Transfer = JSON.parse(wire)
      const receipt = buildTandaTerimaData(decoded, 'Owned Cashier')
      expect(receipt.receiverHeaderLines[0]).toBe(state === 'object' ? 'Mändalika 香' : 'Owned Dest')
      expect(receipt.items[0]?.receivedQty).toBe(2)
      expect(receipt.items[0]?.productName).toBe('Parfum 香')
      expect(JSON.stringify(decoded)).toBe(wire)
    })
  }
})
