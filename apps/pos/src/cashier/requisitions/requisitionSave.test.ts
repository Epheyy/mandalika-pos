import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@mandalika/api'
import type { StockRequisition, StockRequisitionInput } from '@mandalika/api'
import { controllableKV } from '../../../../../packages/sync/src/testFixtures/controllableKV'
import type { FlowDeps, RequisitionApi, RequisitionFormState } from './requisitionFlow'
import { createRequisitionKeys } from './requisitionKeys'
import { discardPending, saveRequisition, submitRequisitionById } from './requisitionSave'

const line = (qty: string) => ({ productId: 'p1', productName: 'A', variantSize: 'M', qty })
const form = (qty = '2'): RequisitionFormState => ({ lines: [line(qty)], neededBy: '', note: '', requestedBy: 'Sari' })
const timeout = () => new ApiError(0, 'x', 'timeout')

/** A stateful fake of the server's keyed writes: the same key replays the PB it created. */
function fakeServer() {
  const byKey = new Map<string, StockRequisition>()
  const rows = new Map<string, StockRequisition>()
  const log = { creates: [] as { key: string; input: StockRequisitionInput }[], updates: [] as { id: string; key: string; input: StockRequisitionInput }[], submits: [] as string[], cancels: [] as string[] }
  const ctl = { loseCreateResponses: 0, submitFails: 0, cancelFails: 0, createError: null as ApiError | null }
  const api = {
    createRequisition: vi.fn(async (input: StockRequisitionInput, key: string) => {
      log.creates.push({ key, input })
      if (ctl.createError) throw ctl.createError
      let pb = byKey.get(key)
      if (!pb) {
        pb = { id: `r${rows.size + 1}`, number: `PB-${rows.size + 1}`, status: 'draft' } as StockRequisition
        byKey.set(key, pb)
        rows.set(pb.id, pb)
      }
      if (ctl.loseCreateResponses > 0) { ctl.loseCreateResponses--; throw timeout() }
      return pb
    }),
    updateRequisition: vi.fn(async (id: string, input: StockRequisitionInput, key: string) => {
      log.updates.push({ id, key, input })
      return rows.get(id)!
    }),
    submitRequisition: vi.fn(async (id: string) => {
      log.submits.push(id)
      if (ctl.submitFails > 0) { ctl.submitFails--; throw timeout() }
      const pb = rows.get(id)!
      pb.status = 'submitted'
      return pb
    }),
    cancelRequisition: vi.fn(async (id: string) => {
      log.cancels.push(id)
      if (ctl.cancelFails > 0) { ctl.cancelFails--; throw timeout() }
      const pb = rows.get(id)!
      pb.status = 'cancelled'
      return pb
    }),
    listRequisitions: vi.fn(), getRequisition: vi.fn(),
  } as unknown as RequisitionApi
  return { api, rows, log, ctl }
}

function setup(online = true) {
  const srv = fakeServer()
  const deps: FlowDeps = { isOnline: () => online, api: srv.api }
  const { kv } = controllableKV()
  const scope = { userId: 'u1', outletId: 'o1' }
  return { ...srv, deps, kv, keys: createRequisitionKeys(kv, scope), restart: () => createRequisitionKeys(kv, scope) }
}

describe('saveRequisition: basics', () => {
  it('refuses an invalid form without any call', async () => {
    const s = setup()
    expect(await saveRequisition({ ...s, form: { ...form(), lines: [] }, andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'invalid' })
    expect(s.api.createRequisition).not.toHaveBeenCalled()
  })

  it('Simpan Draf creates once and does not submit; "Diminta oleh" leads the note; the record is cleared', async () => {
    const s = setup()
    const out = await saveRequisition({ ...s, form: form(), andSubmit: false })
    expect(out).toMatchObject({ kind: 'saved', pb: { id: 'r1' } })
    expect(s.log.creates[0].input.note).toBe('Diminta oleh: Sari')
    expect(s.log.submits).toEqual([])
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('Simpan & Ajukan creates, then submits that draft', async () => {
    const s = setup()
    expect(await saveRequisition({ ...s, form: form(), andSubmit: true })).toMatchObject({ kind: 'saved', pb: { status: 'submitted' } })
    expect(s.log.submits).toEqual(['r1'])
  })

  it('a failed submit leaves the saved draft (draftOnly)', async () => {
    const s = setup()
    s.ctl.submitFails = 1
    expect(await saveRequisition({ ...s, form: form(), andSubmit: true })).toMatchObject({ kind: 'draftOnly', failure: 'retry', pb: { id: 'r1' } })
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('editing updates the draft by id instead of creating', async () => {
    const s = setup()
    await saveRequisition({ ...s, editing: { id: 'r9' }, form: form(), andSubmit: false }).catch(() => undefined)
    expect(s.api.createRequisition).not.toHaveBeenCalled()
    expect(s.log.updates[0].id).toBe('r9')
  })

  it('offline: no call is made and the record is marked unsent, keeping the form for a later restart', async () => {
    const s = setup(false)
    expect(await saveRequisition({ ...s, form: form(), andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'offline' })
    expect(s.api.createRequisition).not.toHaveBeenCalled()
    expect(s.restart().loadPendingCreate()).toMatchObject({ sent: false, form: form() })
  })

  it('a 400 means nothing was created: the record is cleared', async () => {
    const s = setup()
    s.ctl.createError = new ApiError(400, 'ukuran "XXL" tidak ada untuk produk ini')
    expect(await saveRequisition({ ...s, form: form(), andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'invalid', message: 'ukuran "XXL" tidak ada untuk produk ini' })
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('submitRequisitionById reuses its key on a retry and mints a new one after success', async () => {
    const s = setup()
    s.ctl.submitFails = 2
    s.api.submitRequisition = vi.fn(async (_id: string, key: string) => {
      s.log.submits.push(key)
      if (s.ctl.submitFails > 0) { s.ctl.submitFails--; throw timeout() }
      return {} as StockRequisition
    }) as never
    await submitRequisitionById(s.deps, s.keys, 'r1')
    await submitRequisitionById(s.deps, s.keys, 'r1')
    await submitRequisitionById(s.deps, s.keys, 'r1')
    await submitRequisitionById(s.deps, s.keys, 'r1')
    expect(s.log.submits[1]).toBe(s.log.submits[0])
    expect(s.log.submits[2]).toBe(s.log.submits[0])
    expect(s.log.submits[3]).not.toBe(s.log.submits[2])
  })
})

describe('H1: an unconfirmed create is resolved before anything else', () => {
  it('(a) lost response, then an edit: exactly one create key ever, one PB, then an update of that PB', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    expect(await saveRequisition({ ...s, form: form('2'), andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'retry' })
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true })

    const out = await saveRequisition({ ...s, form: form('5'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'saved', pb: { id: 'r1' } })
    expect(new Set(s.log.creates.map((c) => c.key)).size).toBe(1)
    expect(s.log.creates.every((c) => c.input.items[0].requestedQty === 2)).toBe(true) // the OLD body is replayed
    expect(s.rows.size).toBe(1)
    expect(s.log.updates).toHaveLength(1)
    expect(s.log.updates[0]).toMatchObject({ id: 'r1', input: { items: [{ requestedQty: 5 }] } })
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('(a2) retry with unchanged content applies no update', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    expect(await saveRequisition({ ...s, form: form('2'), andSubmit: false })).toMatchObject({ kind: 'saved' })
    expect(s.rows.size).toBe(1)
    expect(s.log.updates).toEqual([])
  })

  it('(a3) Simpan & Ajukan after an unconfirmed create updates, then submits the same PB', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    expect(await saveRequisition({ ...s, form: form('3'), andSubmit: true })).toMatchObject({ kind: 'saved', pb: { id: 'r1', status: 'submitted' } })
    expect(s.rows.size).toBe(1)
    expect(s.log.submits).toEqual(['r1'])
  })

  it('(b) a restart with an unconfirmed record behaves the same', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    const restarted = s.restart()
    expect(restarted.loadPendingCreate()).toMatchObject({ sent: true, form: form('2') })
    const out = await saveRequisition({ ...s, keys: restarted, form: form('7'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'saved', pb: { id: 'r1' } })
    expect(new Set(s.log.creates.map((c) => c.key)).size).toBe(1)
    expect(s.rows.size).toBe(1)
    expect(s.log.updates).toHaveLength(1)
  })

  it('a still-unreachable server keeps the record unconfirmed and sends no new create key', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 2
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    expect(await saveRequisition({ ...s, form: form('9'), andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'retry' })
    expect(new Set(s.log.creates.map((c) => c.key)).size).toBe(1)
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true, input: { items: [{ requestedQty: 2 }] } })
  })

  it('a failed update after the resolved create reports draftOnly: the PB exists and is not recreated', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    s.api.updateRequisition = vi.fn().mockRejectedValue(timeout()) as never
    const out = await saveRequisition({ ...s, form: form('5'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'draftOnly', failure: 'retry', pb: { id: 'r1' } })
    expect(s.rows.size).toBe(1)
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('(c) discarding an unconfirmed record resolves it: the PB it created is cancelled', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    const out = await discardPending(s.deps, s.keys)
    expect(out).toMatchObject({ kind: 'cancelled', pb: { id: 'r1', status: 'cancelled' } })
    expect(s.rows.size).toBe(1)
    expect(s.log.cancels).toEqual(['r1'])
    expect(new Set(s.log.creates.map((c) => c.key)).size).toBe(1)
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('(c2) discard when the cancel fails tells the cashier a draft exists, and does not drop it silently', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    s.ctl.cancelFails = 1
    const out = await discardPending(s.deps, s.keys)
    expect(out).toMatchObject({ kind: 'draftExists', pb: { id: 'r1' } })
    expect(out.kind === 'draftExists' && out.message).toContain('PB-1')
  })

  it('(c3) discard with no answer from the server keeps the record', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 2
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    expect(await discardPending(s.deps, s.keys)).toMatchObject({ kind: 'unresolved', failure: 'retry' })
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true })
  })

  it('(c4) discarding an unsent record just clears it, with no call', async () => {
    const s = setup(false)
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    expect(await discardPending(s.deps, s.keys)).toEqual({ kind: 'discarded' })
    expect(s.api.createRequisition).not.toHaveBeenCalled()
    expect(s.keys.loadPendingCreate()).toBeNull()
  })
})
