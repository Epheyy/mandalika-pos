import { describe, expect, it } from 'vitest'
import { requisitionConfirm } from './requisitionConfirm'

describe('requisitionConfirm', () => {
  it('asks a question naming the requisition for each action', () => {
    for (const action of ['submit', 'cancel', 'fulfil', 'approve'] as const) {
      const c = requisitionConfirm(action, { number: 'PB-9' })
      expect(c.title).toContain('PB-9')
      expect(c.title.endsWith('?')).toBe(true)
      expect(c.confirmLabel).not.toBe('')
    }
  })

  it('only the cancel is a danger action, and its confirm differs from its back button', () => {
    expect(requisitionConfirm('cancel', { number: 'PB-9' }).tone).toBe('danger')
    expect(requisitionConfirm('cancel', { number: 'PB-9' }).cancelLabel).toBe('Kembali')
    expect(requisitionConfirm('submit', { number: 'PB-9' }).tone).toBeUndefined()
  })

  it('states the approved units and the source warehouse on Setujui', () => {
    const c = requisitionConfirm('approve', { number: 'PB-9', approvedUnits: 1200, warehouseName: 'Gudang Pusat' })
    expect(c.consequence).toContain('1.200 unit')
    expect(c.consequence).toContain('Gudang Pusat')
  })

  it('words a repeat transfer as a new one', () => {
    expect(requisitionConfirm('fulfil', { number: 'PB-9' }).confirmLabel).toBe('Buat transfer')
    expect(requisitionConfirm('fulfil', { number: 'PB-9', refulfil: true }).confirmLabel).toBe('Buat transfer ulang')
  })
})
