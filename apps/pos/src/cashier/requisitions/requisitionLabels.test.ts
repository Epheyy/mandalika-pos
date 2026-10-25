import { describe, expect, it } from 'vitest'
import type { StockRequisition } from '@mandalika/api'
import { allowedActions, buildChain } from './requisitionLabels'

type P = Pick<StockRequisition, 'status' | 'transfer' | 'decisionNote'>
const mk = (status: P['status'], transferStatus?: string, decisionNote?: string): P => ({
  status, decisionNote, transfer: transferStatus ? { id: 't1', transferNo: 'TR-1', status: transferStatus } : undefined,
})
const states = (p: P) => buildChain(p).steps.map((s) => `${s.label}:${s.state}`)

describe('buildChain', () => {
  it('has six steps ending in Diterima', () => {
    expect(buildChain(mk('draft')).steps.map((s) => s.label)).toEqual(
      ['Draf', 'Diajukan', 'Disetujui', 'Transfer Dibuat', 'Dikirim', 'Diterima'])
  })

  it('marks the current step on the happy path', () => {
    expect(states(mk('draft'))[0]).toBe('Draf:current')
    expect(states(mk('submitted'))).toEqual(['Draf:done', 'Diajukan:current', 'Disetujui:todo', 'Transfer Dibuat:todo', 'Dikirim:todo', 'Diterima:todo'])
    expect(states(mk('approved'))[2]).toBe('Disetujui:current')
  })

  it('follows the linked transfer: draft/cancelled stay on Transfer Dibuat, in_transit is Dikirim, completed is all done', () => {
    expect(states(mk('fulfilled', 'draft'))[3]).toBe('Transfer Dibuat:current')
    expect(buildChain(mk('fulfilled', 'draft')).steps[3].note).toBe('Disiapkan gudang')
    expect(buildChain(mk('fulfilled', 'cancelled')).steps[3].note).toBe('Transfer dibatalkan, menunggu gudang')
    expect(states(mk('fulfilled', 'in_transit'))).toEqual(['Draf:done', 'Diajukan:done', 'Disetujui:done', 'Transfer Dibuat:done', 'Dikirim:current', 'Diterima:todo'])
    expect(states(mk('fulfilled', 'completed')).every((s) => s.endsWith(':done'))).toBe(true)
  })

  it('rejected and cancelled are dead ends carrying the decision note', () => {
    expect(buildChain(mk('rejected', undefined, 'stok kosong'))).toEqual({ steps: [], deadEnd: { label: 'Ditolak', note: 'stok kosong' } })
    expect(buildChain(mk('cancelled'))).toEqual({ steps: [], deadEnd: { label: 'Dibatalkan', note: undefined } })
  })
})

describe('allowedActions', () => {
  it('draft: edit, submit, cancel; submitted: cancel only; nothing else', () => {
    expect(allowedActions(mk('draft'))).toEqual({ edit: true, submit: true, cancel: true, openReceive: false })
    expect(allowedActions(mk('submitted'))).toEqual({ edit: false, submit: false, cancel: true, openReceive: false })
    for (const s of ['approved', 'rejected', 'cancelled'] as const) {
      expect(allowedActions(mk(s))).toEqual({ edit: false, submit: false, cancel: false, openReceive: false })
    }
  })

  it('opens the receive panel only while the transfer is in transit', () => {
    expect(allowedActions(mk('fulfilled', 'in_transit')).openReceive).toBe(true)
    expect(allowedActions(mk('fulfilled', 'draft')).openReceive).toBe(false)
    expect(allowedActions(mk('fulfilled', 'completed')).openReceive).toBe(false)
    expect(allowedActions(mk('fulfilled', 'in_transit')).cancel).toBe(false)
  })
})
