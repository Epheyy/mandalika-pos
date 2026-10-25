import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@mandalika/api'
import type { StockRequisition } from '@mandalika/api'
import {
  BUSY_PREFIX, EMPTY_FORM, FEATURE_OFF_MESSAGE, KEY_CONFLICT_PREFIX, MAX_NOTE, MAX_REQUESTED_BY, MSG_TOO_LONG, formFromRequisition, splitNote, FORBIDDEN_MESSAGE, MSG_BAD_QTY, MSG_DUPLICATE, MSG_NO_LINES, NOT_FOUND_MESSAGE,
  OFFLINE_MESSAGE, REQUEST_TIMEOUT_MS, RETRY_MESSAGE, buildInput, cancelRequisition, composeNote, createDraft,
  loadRequisition, loadRequisitions, submitDraft, updateDraft,
  type FlowDeps, type RequisitionApi,
} from './requisitionFlow'

const pb = { id: 'r1', number: 'PB-2026-00001', status: 'draft' } as StockRequisition

function deps(over: Partial<RequisitionApi> = {}, online = true) {
  const api: RequisitionApi = {
    listRequisitions: vi.fn().mockResolvedValue({ data: [pb] }),
    getRequisition: vi.fn().mockResolvedValue(pb),
    createRequisition: vi.fn().mockResolvedValue(pb),
    updateRequisition: vi.fn().mockResolvedValue(pb),
    submitRequisition: vi.fn().mockResolvedValue(pb),
    cancelRequisition: vi.fn().mockResolvedValue(pb),
    ...over,
  }
  const d: FlowDeps = { isOnline: () => online, api }
  return { d, api }
}
type Kind = 'http' | 'network' | 'timeout' | 'invalid_response'
const fail = (status: number, message: string, kind: Kind = 'http') =>
  vi.fn().mockRejectedValue(new ApiError(status, message, kind))
const input = { items: [{ productId: 'p', variantSize: 'M', requestedQty: 1 }] }

describe('requisitionFlow outcomes', () => {
  it('ok passes the value through, with the 20s deadline and the key', async () => {
    const { d, api } = deps()
    expect(await createDraft(d, input, 'k1')).toEqual({ kind: 'ok', value: pb })
    expect(api.createRequisition).toHaveBeenCalledWith(input, 'k1', { timeoutMs: REQUEST_TIMEOUT_MS })
  })

  it('offline makes no call for any operation', async () => {
    const { d, api } = deps({}, false)
    const all = [
      await loadRequisitions(d, 'o1'), await loadRequisition(d, 'r1'), await createDraft(d, input, 'k'),
      await updateDraft(d, 'r1', input, 'k'), await submitDraft(d, 'r1', 'k'), await cancelRequisition(d, 'r1', 'k'),
    ]
    for (const r of all) expect(r).toEqual({ kind: 'offline', message: OFFLINE_MESSAGE })
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled()
  })

  it('network, timeout, 5xx, 429 and an unparseable answer are retry with the reassuring copy', async () => {
    const cases: [number, Kind][] = [
      [0, 'network'], [0, 'timeout'], [502, 'http'], [503, 'http'], [429, 'http'], [200, 'invalid_response'],
    ]
    for (const [status, kind] of cases) {
      const { d } = deps({ submitRequisition: fail(status, 'x', kind) })
      expect(await submitDraft(d, 'r1', 'k')).toEqual({ kind: 'retry', message: RETRY_MESSAGE })
    }
    const { d } = deps({ submitRequisition: vi.fn().mockRejectedValue(new Error('boom')) })
    expect(await submitDraft(d, 'r1', 'k')).toMatchObject({ kind: 'retry' })
  })

  it('a retry reuses whatever key the caller passes (the flow never mints one)', async () => {
    const { d, api } = deps({ createRequisition: fail(0, 'x', 'timeout') })
    await createDraft(d, input, 'same')
    await createDraft(d, input, 'same')
    expect(vi.mocked(api.createRequisition).mock.calls.map((c) => c[1])).toEqual(['same', 'same'])
  })

  it('409 action-not-allowed is stale (refetch), 409 key reuse is keyConflict', async () => {
    const stale = deps({ submitRequisition: fail(409, "aksi tidak diizinkan dari status 'submitted'") })
    expect(await submitDraft(stale.d, 'r1', 'k')).toMatchObject({ kind: 'stale' })
    const key = deps({ createRequisition: fail(409, 'kunci idempotensi sudah dipakai untuk permintaan lain') })
    expect(await createDraft(key.d, input, 'k')).toMatchObject({ kind: 'keyConflict' })
  })

  it('404 is gone on detail/writes and "feature off" on the list', async () => {
    const g = deps({ getRequisition: fail(404, 'not found') })
    expect(await loadRequisition(g.d, 'r1')).toEqual({ kind: 'gone', message: NOT_FOUND_MESSAGE })
    const w = deps({ cancelRequisition: fail(404, 'not found') })
    expect(await cancelRequisition(w.d, 'r1', 'k')).toEqual({ kind: 'gone', message: NOT_FOUND_MESSAGE })
    const l = deps({ listRequisitions: fail(404, 'not found') })
    expect(await loadRequisitions(l.d, 'o1')).toEqual({ kind: 'gone', message: FEATURE_OFF_MESSAGE })
  })

  it('403 is forbidden with the grant copy', async () => {
    const { d } = deps({ listRequisitions: fail(403, 'forbidden') })
    expect(await loadRequisitions(d, 'o1')).toEqual({ kind: 'forbidden', message: FORBIDDEN_MESSAGE })
  })

  it('400 shows the server Indonesian text', async () => {
    const { d } = deps({ createRequisition: fail(400, 'qty harus lebih dari 0') })
    expect(await createDraft(d, input, 'k')).toEqual({ kind: 'invalid', message: 'qty harus lebih dari 0' })
  })

  it('a list without an outlet is refused before any call (it would otherwise be unpinned)', async () => {
    const { d, api } = deps()
    expect(await loadRequisitions(d, '')).toMatchObject({ kind: 'invalid' })
    expect(api.listRequisitions).not.toHaveBeenCalled()
  })

  it('the list call always carries the outletId, even when a filter is given', async () => {
    const { d, api } = deps()
    await loadRequisitions(d, 'outlet-1', { status: 'draft' })
    expect(api.listRequisitions).toHaveBeenCalledWith({ status: 'draft', outletId: 'outlet-1' }, { timeoutMs: REQUEST_TIMEOUT_MS })
  })
})

describe('buildInput / composeNote', () => {
  const line = { productId: 'p1', productName: 'A', variantSize: 'M', qty: '2' }
  it('refuses no lines, a bad qty and a duplicate product+size', () => {
    expect(buildInput(EMPTY_FORM)).toEqual({ ok: false, message: MSG_NO_LINES })
    expect(buildInput({ ...EMPTY_FORM, lines: [{ ...line, qty: '0' }] })).toEqual({ ok: false, message: MSG_BAD_QTY })
    expect(buildInput({ ...EMPTY_FORM, lines: [{ ...line, qty: '1.5' }] })).toEqual({ ok: false, message: MSG_BAD_QTY })
    expect(buildInput({ ...EMPTY_FORM, lines: [line, line] })).toEqual({ ok: false, message: MSG_DUPLICATE })
  })

  it('builds the input; the same product in a different size is allowed', () => {
    const r = buildInput({ ...EMPTY_FORM, lines: [line, { ...line, variantSize: 'L' }], neededBy: '2026-11-03' })
    expect(r).toEqual({ ok: true, input: {
      items: [{ productId: 'p1', variantSize: 'M', requestedQty: 2 }, { productId: 'p1', variantSize: 'L', requestedQty: 2 }],
      note: undefined, neededBy: '2026-11-03',
    } })
  })

  it('"Diminta oleh" is saved as the first line of the note', () => {
    expect(composeNote('Sari', 'untuk event')).toBe('Diminta oleh: Sari\nuntuk event')
    expect(composeNote('  Sari ', '')).toBe('Diminta oleh: Sari')
    expect(composeNote('', ' catatan ')).toBe('catatan')
    expect(composeNote('', '')).toBeUndefined()
  })
})


describe('splitNote / formFromRequisition', () => {
  it('splitNote inverts composeNote', () => {
    for (const [by, note] of [['Sari', 'untuk event'], ['Sari', ''], ['', 'catatan'], ['', '']]) {
      expect(splitNote(composeNote(by, note))).toEqual({ requestedBy: by, note })
    }
  })

  it('formFromRequisition rebuilds the editable form from a draft', () => {
    const f = formFromRequisition({
      note: 'Diminta oleh: Sari\nevent', neededBy: '2026-11-03',
      items: [{ id: 'i1', productId: 'p1', productName: 'A', variantSize: 'M', sku: 'S1', requestedQty: 3 }],
    })
    expect(f).toEqual({ requestedBy: 'Sari', note: 'event', neededBy: '2026-11-03', lines: [{ productId: 'p1', productName: 'A', variantSize: 'M', sku: 'S1', qty: '3' }] })
  })
})

describe("server text contract (L1/L2)", () => {
  // The same literals are asserted against the real Go errors in backend/internal/handlers/client_contract_prefix_test.go.
  it("pins the two prefixes the client matches", () => {
    expect(KEY_CONFLICT_PREFIX).toBe("kunci idempotensi")
    expect(BUSY_PREFIX).toBe("sedang diproses permintaan lain")
  })

  it("a lock-conflict 409 is retry, not stale; the real texts map as the server sends them", async () => {
    const busy = deps({ submitRequisition: fail(409, "sedang diproses permintaan lain, silakan coba lagi") })
    expect(await submitDraft(busy.d, "r1", "k")).toEqual({ kind: "retry", message: RETRY_MESSAGE })
    const key = deps({ submitRequisition: fail(409, "kunci idempotensi sudah dipakai untuk operasi lain") })
    expect(await submitDraft(key.d, "r1", "k")).toMatchObject({ kind: "keyConflict" })
  })
})

describe("input length caps (L8)", () => {
  const line = { productId: "p1", productName: "A", variantSize: "M", qty: "1" }
  it("refuses a name or note over the cap and accepts exactly the cap", () => {
    expect(buildInput({ ...EMPTY_FORM, lines: [line], requestedBy: "x".repeat(MAX_REQUESTED_BY + 1) })).toEqual({ ok: false, message: MSG_TOO_LONG })
    expect(buildInput({ ...EMPTY_FORM, lines: [line], note: "x".repeat(MAX_NOTE + 1) })).toEqual({ ok: false, message: MSG_TOO_LONG })
    expect(buildInput({ ...EMPTY_FORM, lines: [line], requestedBy: "x".repeat(MAX_REQUESTED_BY), note: "y".repeat(MAX_NOTE) }).ok).toBe(true)
  })
})
