import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@mandalika/api'
import type { StockRequisition, StockRequisitionInput } from '@mandalika/api'
import { controllableKV } from '../../../../../packages/sync/src/testFixtures/controllableKV'
import type { FlowDeps, RequisitionApi, RequisitionFormState } from './requisitionFlow'
import { createRequisitionKeys } from './requisitionKeys'
import { MAYBE_SAVED_MESSAGE, discardPending, resolvePendingCreate, saveRequisition, submitRequisitionById } from './requisitionSave'

const line = (qty: string) => ({ productId: 'p1', productName: 'A', variantSize: 'M', qty })
const form = (qty = '2'): RequisitionFormState => ({ lines: [line(qty)], neededBy: '', note: '', requestedBy: 'Sari' })
const timeout = () => new ApiError(0, 'x', 'timeout')
const domain400 = (msg = 'ukuran "XXL" tidak ada untuk produk ini') => new ApiError(400, msg, 'http', { error: msg })
const keyConflict = () => new ApiError(409, 'kunci idempotensi sudah dipakai untuk operasi lain', 'http', { error: 'kunci idempotensi sudah dipakai untuk operasi lain' })

/** A stateful fake of the server's keyed writes: the same key replays the PB it created. Replies are copies. */
function fakeServer() {
  const byKey = new Map<string, StockRequisition>()
  const rows = new Map<string, StockRequisition>()
  const log = { creates: [] as { key: string; input: StockRequisitionInput }[], updates: [] as { id: string; key: string; input: StockRequisitionInput }[], submits: [] as string[], cancels: [] as string[] }
  const ctl = { loseCreateResponses: 0, submitFails: 0, cancelFails: 0, createError: null as ApiError | null, getError: null as ApiError | null }
  const api = {
    createRequisition: vi.fn(async (input: StockRequisitionInput, key: string) => {
      log.creates.push({ key, input })
      if (ctl.createError) throw ctl.createError
      let pb = byKey.get(key)
      if (!pb) {
        pb = { id: `r${rows.size + 1}`, number: `PB-${rows.size + 1}`, status: 'draft', updatedAt: 't0' } as StockRequisition
        byKey.set(key, pb)
        rows.set(pb.id, pb)
      }
      if (ctl.loseCreateResponses > 0) { ctl.loseCreateResponses--; throw timeout() }
      return { ...pb }
    }),
    getRequisition: vi.fn(async (id: string) => {
      if (ctl.getError) throw ctl.getError
      return { ...rows.get(id)! }
    }),
    updateRequisition: vi.fn(async (id: string, input: StockRequisitionInput, key: string) => {
      log.updates.push({ id, key, input })
      return { ...rows.get(id)! }
    }),
    submitRequisition: vi.fn(async (id: string) => {
      log.submits.push(id)
      if (ctl.submitFails > 0) { ctl.submitFails--; throw timeout() }
      const pb = rows.get(id)!
      pb.status = 'submitted'
      return { ...pb }
    }),
    cancelRequisition: vi.fn(async (id: string) => {
      log.cancels.push(id)
      if (ctl.cancelFails > 0) { ctl.cancelFails--; throw timeout() }
      const pb = rows.get(id)!
      pb.status = 'cancelled'
      return { ...pb }
    }),
    listRequisitions: vi.fn(),
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
const createKeys = (s: ReturnType<typeof setup>) => new Set(s.log.creates.map((c) => c.key))

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
    expect(await saveRequisition({ ...s, form: form(), andSubmit: true })).toMatchObject({ kind: 'draftOnly', step: 'submit', failure: 'retry', pb: { id: 'r1' } })
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

  it('a JSON 400 domain refusal means nothing was created: the record is cleared', async () => {
    const s = setup()
    s.ctl.createError = domain400()
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
    expect(createKeys(s).size).toBe(1)
    expect(s.log.creates.every((c) => c.input.items[0].requestedQty === 2)).toBe(true) // the OLD body is replayed
    expect(s.rows.size).toBe(1)
    expect(s.log.updates).toHaveLength(1)
    expect(s.log.updates[0]).toMatchObject({ id: 'r1', input: { items: [{ requestedQty: 5 }] } })
    expect(s.log.updates[0].key).not.toBe(s.log.creates[0].key)
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
    expect(createKeys(s).size).toBe(1)
    expect(s.rows.size).toBe(1)
    expect(s.log.updates).toHaveLength(1)
  })

  it('a still-unreachable server keeps the record unconfirmed and sends no new create key', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 2
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    expect(await saveRequisition({ ...s, form: form('9'), andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'retry' })
    expect(createKeys(s).size).toBe(1)
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true, input: { items: [{ requestedQty: 2 }] } })
  })

  it('a failed update after the resolved create reports draftOnly(update): the PB exists and is not recreated', async () => {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    s.api.updateRequisition = vi.fn().mockRejectedValue(timeout()) as never
    const out = await saveRequisition({ ...s, form: form('5'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'draftOnly', step: 'update', failure: 'retry', pb: { id: 'r1' } })
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
    expect(createKeys(s).size).toBe(1)
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

describe('M1: a resolve never falls through to a fresh create, and only a proven refusal clears the record', () => {
  async function lost() {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    return s
  }

  it('a 401 keeps the record, on the first attempt and on the resolve, and never mints a second create key', async () => {
    const s = setup()
    s.ctl.createError = new ApiError(401, 'unauthorized')
    expect(await saveRequisition({ ...s, form: form('2'), andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'unauthorized' })
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true })
    const out = await saveRequisition({ ...s, form: form('9'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'failed', failure: 'unauthorized' })
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true, input: { items: [{ requestedQty: 2 }] } })
    expect(createKeys(s).size).toBe(1)
  })

  it.each([
    ['408', new ApiError(408, 'request timeout')],
    ['413', new ApiError(413, 'payload too large')],
    ['a non-JSON 400', new ApiError(400, 'request failed (400)')],
  ])('%s keeps the record (it does not prove nothing was created)', async (_n, err) => {
    const s = await lost()
    s.ctl.createError = err
    const out = await saveRequisition({ ...s, form: form('9'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'failed', failure: 'unconfirmed' })
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true })
    expect(createKeys(s).size).toBe(1)
  })

  it('a key conflict on the resolve means "may already be saved": cleared, a failure, and no second create in that call', async () => {
    const s = await lost()
    s.ctl.createError = keyConflict()
    const out = await saveRequisition({ ...s, form: form('9'), andSubmit: false })
    expect(out).toEqual({ kind: 'failed', failure: 'keyConflict', message: MAYBE_SAVED_MESSAGE })
    expect(s.log.creates).toHaveLength(2) // the original and the replay, nothing else
    expect(createKeys(s).size).toBe(1)
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('a JSON 400 domain refusal on the resolve clears the record and does NOT create in the same call', async () => {
    const s = await lost()
    s.ctl.createError = domain400()
    const out = await saveRequisition({ ...s, form: form('9'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'failed', failure: 'invalid' })
    expect(s.log.creates).toHaveLength(2)
    expect(createKeys(s).size).toBe(1)
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('a key conflict on a fresh create is also "may already be saved"', async () => {
    const s = setup()
    s.ctl.createError = keyConflict()
    expect(await saveRequisition({ ...s, form: form('2'), andSubmit: false })).toMatchObject({ kind: 'failed', failure: 'keyConflict', message: MAYBE_SAVED_MESSAGE })
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('discard: a key conflict is NOT "discarded": nothing is cancelled and the cashier is told a PB may exist', async () => {
    const s = await lost()
    s.ctl.createError = keyConflict()
    expect(await discardPending(s.deps, s.keys)).toEqual({ kind: 'maybeSaved', message: MAYBE_SAVED_MESSAGE })
    expect(s.log.cancels).toEqual([])
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('discard: a 401 keeps the record', async () => {
    const s = await lost()
    s.ctl.createError = new ApiError(401, 'unauthorized')
    expect(await discardPending(s.deps, s.keys)).toMatchObject({ kind: 'unresolved', failure: 'unauthorized' })
    expect(s.keys.loadPendingCreate()).toMatchObject({ sent: true })
  })

  it('discard: a JSON domain refusal means nothing exists, so it is discarded', async () => {
    const s = await lost()
    s.ctl.createError = domain400()
    expect(await discardPending(s.deps, s.keys)).toEqual({ kind: 'discarded' })
    expect(s.keys.loadPendingCreate()).toBeNull()
  })
})

describe('M2: a stale record cannot take over a PB the cashier already knows', () => {
  async function lost() {
    const s = setup()
    s.ctl.loseCreateResponses = 1
    await saveRequisition({ ...s, form: form('2'), andSubmit: false })
    return s
  }

  it('save: the replayed PB was already submitted: no update, no submit, it is opened and the cashier is told', async () => {
    const s = await lost()
    s.rows.get('r1')!.status = 'submitted'
    const out = await saveRequisition({ ...s, form: form('9'), andSubmit: true })
    expect(out).toMatchObject({ kind: 'foundChanged', pb: { id: 'r1', status: 'submitted' } })
    expect(out.kind === 'foundChanged' && out.message).toContain('PB-1')
    expect(s.log.updates).toEqual([])
    expect(s.log.submits).toEqual([])
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it("save: the replayed PB is still a draft but moved on (updatedAt differs from the replay): no update", async () => {
    const s = await lost()
    // the replay answer carries the creation-time updatedAt; meanwhile the stored PB changed
    vi.mocked(s.api.createRequisition).mockImplementationOnce(async () => ({ id: "r1", number: "PB-1", status: "draft", updatedAt: "t0" }) as StockRequisition)
    s.rows.get("r1")!.updatedAt = "t9"
    expect(await saveRequisition({ ...s, form: form("9"), andSubmit: false })).toMatchObject({ kind: "foundChanged", pb: { id: "r1" } })
    expect(s.log.updates).toEqual([])
  })

  it('save: when the replayed PB cannot be re-read nothing is overwritten (draftOnly update, retry)', async () => {
    const s = await lost()
    s.ctl.getError = timeout()
    const out = await saveRequisition({ ...s, form: form('9'), andSubmit: false })
    expect(out).toMatchObject({ kind: 'draftOnly', step: 'update', failure: 'retry', pb: { id: 'r1' } })
    expect(s.log.updates).toEqual([])
  })

  it('discard: the replayed PB was already submitted: it is NOT cancelled', async () => {
    const s = await lost()
    s.rows.get('r1')!.status = 'submitted'
    const out = await discardPending(s.deps, s.keys)
    expect(out).toMatchObject({ kind: 'draftExists', pb: { id: 'r1', status: 'submitted' } })
    expect(s.log.cancels).toEqual([])
    expect(s.keys.loadPendingCreate()).toBeNull()
  })

  it('discard: when the replayed PB cannot be re-read it is not cancelled either', async () => {
    const s = await lost()
    s.ctl.getError = timeout()
    expect(await discardPending(s.deps, s.keys)).toMatchObject({ kind: 'draftExists', pb: { id: 'r1' } })
    expect(s.log.cancels).toEqual([])
  })

  it('resolvePendingCreate (the eager resolve when the panel opens): success clears the record and returns the PB', async () => {
    const s = await lost()
    const res = await resolvePendingCreate(s.deps, s.restart())
    expect(res).toMatchObject({ kind: 'resolved', pb: { id: 'r1', number: 'PB-1' } })
    expect(s.restart().loadPendingCreate()).toBeNull()
    expect(s.rows.size).toBe(1)
    // a later save of new content is a fresh, separate PB with a NEW key (the record no longer exists)
    await saveRequisition({ ...s, keys: s.restart(), form: form('4'), andSubmit: false })
    expect(s.rows.size).toBe(2)
    expect(createKeys(s).size).toBe(2)
  })

  it('resolvePendingCreate: nothing pending is a no-op; offline keeps the record; a conflict is maybeSaved', async () => {
    const s = setup()
    expect(await resolvePendingCreate(s.deps, s.keys)).toEqual({ kind: 'none' })
    const l = await lost()
    const offline = { ...l.deps, isOnline: () => false }
    expect(await resolvePendingCreate(offline, l.keys)).toMatchObject({ kind: 'blocked', failure: 'offline' })
    expect(l.keys.loadPendingCreate()).toMatchObject({ sent: true })
    l.ctl.createError = keyConflict()
    expect(await resolvePendingCreate(l.deps, l.keys)).toEqual({ kind: 'maybeSaved', message: MAYBE_SAVED_MESSAGE })
    expect(l.keys.loadPendingCreate()).toBeNull()
  })
})
