import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@mandalika/api'
import type { StockRequisition } from '@mandalika/api'
import { controllableKV } from '../../../../../packages/sync/src/testFixtures/controllableKV'
import type { FlowDeps, RequisitionApi, RequisitionFormState } from './requisitionFlow'
import { createRequisitionKeys } from './requisitionKeys'
import { saveRequisition, submitRequisitionById } from './requisitionSave'

const draft = { id: 'r1', number: 'PB-1', status: 'draft' } as StockRequisition
const submitted = { ...draft, status: 'submitted' } as StockRequisition
const form: RequisitionFormState = {
  lines: [{ productId: 'p1', productName: 'A', variantSize: 'M', qty: '2' }], neededBy: '', note: '', requestedBy: 'Sari',
}

function setup(over: Partial<RequisitionApi> = {}) {
  const api = {
    createRequisition: vi.fn().mockResolvedValue(draft),
    updateRequisition: vi.fn().mockResolvedValue(draft),
    submitRequisition: vi.fn().mockResolvedValue(submitted),
    cancelRequisition: vi.fn(), listRequisitions: vi.fn(), getRequisition: vi.fn(),
    ...over,
  } as RequisitionApi
  const deps: FlowDeps = { isOnline: () => true, api }
  const { kv } = controllableKV()
  const keys = createRequisitionKeys(kv, { userId: 'u1', outletId: 'o1' })
  return { deps, api, keys, kv }
}
const err = (status: number, message: string, kind: 'http' | 'network' | 'timeout' = 'http') =>
  vi.fn().mockRejectedValue(new ApiError(status, message, kind))

describe('saveRequisition', () => {
  it('refuses an invalid form without any call', async () => {
    const s = setup()
    const out = await saveRequisition({ ...s, form: { ...form, lines: [] }, andSubmit: false })
    expect(out).toMatchObject({ kind: 'failed', failure: 'invalid' })
    expect(s.api.createRequisition).not.toHaveBeenCalled()
  })

  it('Simpan Draf creates once and does not submit; "Diminta oleh" leads the note', async () => {
    const s = setup()
    const out = await saveRequisition({ ...s, form, andSubmit: false })
    expect(out).toEqual({ kind: 'saved', pb: draft })
    expect(vi.mocked(s.api.createRequisition).mock.calls[0][0].note).toBe('Diminta oleh: Sari')
    expect(s.api.submitRequisition).not.toHaveBeenCalled()
  })

  it('Simpan & Ajukan creates, then submits that draft', async () => {
    const s = setup()
    const order: string[] = []
    vi.mocked(s.api.createRequisition).mockImplementation(async () => { order.push('create'); return draft })
    vi.mocked(s.api.submitRequisition).mockImplementation(async () => { order.push('submit'); return submitted })
    expect(await saveRequisition({ ...s, form, andSubmit: true })).toEqual({ kind: 'saved', pb: submitted })
    expect(order).toEqual(['create', 'submit'])
    expect(vi.mocked(s.api.submitRequisition).mock.calls[0][0]).toBe('r1')
  })

  it('a failed submit leaves the saved draft (draftOnly) and the create key is cleared', async () => {
    const s = setup({ submitRequisition: err(0, 'x', 'timeout') })
    const out = await saveRequisition({ ...s, form, andSubmit: true })
    expect(out).toMatchObject({ kind: 'draftOnly', pb: draft, failure: 'retry' })
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('a lost create response retries with the same key, even after an app restart', async () => {
    const s = setup({ createRequisition: err(0, 'x', 'network') })
    expect(await saveRequisition({ ...s, form, andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'retry' })
    expect(s.keys.loadPendingCreate()).not.toBeNull()
    const restarted = createRequisitionKeys(s.kv, { userId: 'u1', outletId: 'o1' })
    vi.mocked(s.api.createRequisition).mockResolvedValue(draft)
    await saveRequisition({ ...s, keys: restarted, form, andSubmit: false })
    const [first, second] = vi.mocked(s.api.createRequisition).mock.calls
    expect(second[1]).toBe(first[1])
    expect(restarted.loadPendingCreate()).toBeNull()
  })

  it('editing the form after a failed create mints a new key', async () => {
    const s = setup({ createRequisition: err(0, 'x', 'network') })
    await saveRequisition({ ...s, form, andSubmit: false })
    await saveRequisition({ ...s, form: { ...form, lines: [{ ...form.lines[0], qty: '3' }] }, andSubmit: false })
    const [a, b] = vi.mocked(s.api.createRequisition).mock.calls
    expect(b[1]).not.toBe(a[1])
  })

  it('a key conflict on create mints a new key for the next save', async () => {
    const s = setup({ createRequisition: err(409, 'kunci idempotensi sudah dipakai untuk permintaan lain') })
    expect(await saveRequisition({ ...s, form, andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'keyConflict' })
    vi.mocked(s.api.createRequisition).mockResolvedValue(draft)
    await saveRequisition({ ...s, form, andSubmit: false })
    const [a, b] = vi.mocked(s.api.createRequisition).mock.calls
    expect(b[1]).not.toBe(a[1])
  })

  it('editing updates the draft by id instead of creating', async () => {
    const s = setup()
    await saveRequisition({ ...s, editing: draft, form, andSubmit: false })
    expect(s.api.createRequisition).not.toHaveBeenCalled()
    expect(vi.mocked(s.api.updateRequisition).mock.calls[0][0]).toBe('r1')
  })

  it('submitRequisitionById reuses its key on a retry and mints a new one after success', async () => {
    const s = setup({ submitRequisition: err(0, 'x', 'timeout') })
    await submitRequisitionById(s.deps, s.keys, 'r1')
    await submitRequisitionById(s.deps, s.keys, 'r1')
    vi.mocked(s.api.submitRequisition).mockResolvedValue(submitted)
    await submitRequisitionById(s.deps, s.keys, 'r1')
    await submitRequisitionById(s.deps, s.keys, 'r1')
    const keysUsed = vi.mocked(s.api.submitRequisition).mock.calls.map((c) => c[1])
    expect(keysUsed[1]).toBe(keysUsed[0])
    expect(keysUsed[2]).toBe(keysUsed[0])
    expect(keysUsed[3]).not.toBe(keysUsed[2])
  })
})
