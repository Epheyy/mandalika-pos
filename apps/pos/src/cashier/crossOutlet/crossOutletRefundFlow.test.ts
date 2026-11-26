import { describe, expect, it, vi } from 'vitest'
import { ApiError, type CrossOutletRefundResult } from '@mandalika/api'
import type { KV } from '@mandalika/sync'
import { createAttemptStore } from './crossOutletAttempt'
import {
  CROSS_CHECK_FIRST, CROSS_OFFLINE_REFUND, CROSS_STORE_FAILED, crossPendingOther,
  resendPendingCrossOutletRefund, submitCrossOutletRefund, type CrossOutletSubmit,
} from './crossOutletRefundFlow'

const KEY = 'mandalika.pos.crossOutletAttempt'
const memory = (failWrites = false): KV & { map: Map<string, string>; sets: number } => {
  const map = new Map<string, string>()
  const st = {
    map, sets: 0,
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => { map.set(k, v) },
    remove: (k: string) => { map.delete(k) },
    setDurable: async (k: string, v: string) => { st.sets += 1; if (failWrites) throw new Error('quota'); map.set(k, v) },
    removeDurable: async (k: string) => { map.delete(k) },
  }
  return st
}

const sub = (over: Partial<CrossOutletSubmit> = {}, items = [{ lineNo: 0, quantity: 1 }]): CrossOutletSubmit => ({
  orderId: 'o1', orderNumber: 'LWB-9', shiftId: 'sh1', deviceId: 'dev1',
  payload: { items, refundAmount: 50000, reason: 'Rusak/cacat', reasonCode: 'rusak_cacat' }, ...over,
})
const RESULT = { refundId: 'r1', refundState: 'partial', amount: 50000, replayed: false, saleOutletId: 'x', refund: {}, order: { order: {} } } as unknown as CrossOutletRefundResult

function setup(opts: { online?: boolean; api?: (id: string, body: unknown) => Promise<CrossOutletRefundResult>; failWrites?: boolean } = {}) {
  const storage = memory(opts.failWrites)
  const refundCrossOutlet = vi.fn(opts.api ?? (async () => RESULT))
  let n = 0
  const deps = {
    api: { refundCrossOutlet }, store: createAttemptStore(storage), newUuid: () => `uuid-${++n}`, isOnline: opts.online ?? true,
  }
  return { storage, refundCrossOutlet, deps }
}

describe('submitCrossOutletRefund', () => {
  it('offline: refuses with the clear copy, stores nothing and sends nothing', async () => {
    const { storage, refundCrossOutlet, deps } = setup({ online: false })
    const out = await submitCrossOutletRefund(deps, sub())
    expect(out).toEqual({ kind: 'offline', message: CROSS_OFFLINE_REFUND })
    expect(CROSS_OFFLINE_REFUND).toBe('Butuh internet. Refund outlet lain hanya bisa online.')
    expect(storage.sets).toBe(0)
    expect(refundCrossOutlet).not.toHaveBeenCalled()
  })

  it('201: persists the attempt BEFORE sending, then clears it and gives the pay-out message', async () => {
    const { storage, refundCrossOutlet, deps } = setup({
      api: async () => { expect(storage.map.size).toBe(1); return RESULT },
    })
    const out = await submitCrossOutletRefund(deps, sub())
    expect(refundCrossOutlet).toHaveBeenCalledTimes(1)
    expect(out.kind).toBe('applied')
    if (out.kind === 'applied') {
      expect(out.replayed).toBe(false)
      expect(out.message).toMatch(/^Refund LWB-9 berhasil\. Bayar .*50\.000.* ke pelanggan\.$/)
      expect(out.result).toBe(RESULT)
    }
    expect(storage.map.size).toBe(0)
    const [id, body] = refundCrossOutlet.mock.calls[0]
    expect(id).toBe('o1')
    expect(body).toEqual({
      clientRefundUuid: 'uuid-1', deviceId: 'dev1', shiftId: 'sh1', reason: 'Rusak/cacat', reasonCode: 'rusak_cacat',
      items: [{ lineNo: 0, quantity: 1 }], refundAmount: 50000,
    })
  })

  it('200 replayed: says it was stored before and pays only if not yet paid', async () => {
    const { deps } = setup({ api: async () => ({ ...RESULT, replayed: true }) })
    const out = await submitCrossOutletRefund(deps, sub())
    expect(out.kind).toBe('applied')
    if (out.kind === 'applied') {
      expect(out.replayed).toBe(true)
      expect(out.message).toMatch(/^Refund ini sudah tersimpan sebelumnya \(.*50\.000.*\)\. Bayar hanya jika belum dibayar\.$/)
    }
  })

  it('timeout: keeps the attempt, shows the cek-dulu copy, and the retry sends the byte-identical body', async () => {
    let calls = 0
    const { storage, refundCrossOutlet, deps } = setup({
      api: async () => { calls += 1; if (calls === 1) throw new ApiError(0, 'timeout', 'timeout'); return RESULT },
    })
    const first = await submitCrossOutletRefund(deps, sub())
    expect(first).toEqual({ kind: 'unsure', message: CROSS_CHECK_FIRST })
    expect(first.kind === 'unsure' && first.message).toContain('Cek dulu')
    expect(storage.map.size).toBe(1)
    const second = await submitCrossOutletRefund(deps, sub())
    expect(second.kind).toBe('applied')
    expect(refundCrossOutlet.mock.calls[1][1]).toEqual(refundCrossOutlet.mock.calls[0][1])
    expect(JSON.stringify(refundCrossOutlet.mock.calls[1][1])).toBe(JSON.stringify(refundCrossOutlet.mock.calls[0][1]))
    expect(storage.map.size).toBe(0)
  })

  it.each([500, 503, 429])('HTTP %i keeps the attempt (retryable)', async (status) => {
    const { storage, deps } = setup({ api: async () => { throw new ApiError(status, 'server', 'http') } })
    expect((await submitCrossOutletRefund(deps, sub())).kind).toBe('unsure')
    expect(storage.map.size).toBe(1)
  })

  it.each([400, 403, 409])('HTTP %i clears the attempt and shows the server message', async (status) => {
    const { storage, deps } = setup({ api: async () => { throw new ApiError(status, 'Sudah direfund. jangan bayar ulang', 'http') } })
    const out = await submitCrossOutletRefund(deps, sub())
    expect(out).toEqual({ kind: 'refused', message: 'Sudah direfund. jangan bayar ulang' })
    expect(storage.map.size).toBe(0)
  })

  it('a storage write failure sends nothing', async () => {
    const { refundCrossOutlet, deps } = setup({ failWrites: true })
    const out = await submitCrossOutletRefund(deps, sub())
    expect(out).toEqual({ kind: 'storeFailed', message: CROSS_STORE_FAILED })
    expect(refundCrossOutlet).not.toHaveBeenCalled()
  })

  it('a changed selection with a pending attempt mints no new uuid and sends nothing', async () => {
    const { storage, refundCrossOutlet, deps } = setup({ api: async () => { throw new ApiError(0, 'net', 'network') } })
    await submitCrossOutletRefund(deps, sub())
    refundCrossOutlet.mockClear()
    const stored = storage.map.get('mandalika.pos.crossOutletAttempt')
    const out = await submitCrossOutletRefund(deps, sub({}, [{ lineNo: 0, quantity: 2 }]))
    expect(out).toEqual({ kind: 'blocked', message: CROSS_CHECK_FIRST })
    expect(refundCrossOutlet).not.toHaveBeenCalled()
    expect(storage.map.get('mandalika.pos.crossOutletAttempt')).toBe(stored)
  })

  it('a pending attempt for another order blocks a new cross refund', async () => {
    const { refundCrossOutlet, deps } = setup({ api: async () => { throw new ApiError(0, 'net', 'network') } })
    await submitCrossOutletRefund(deps, sub())
    refundCrossOutlet.mockClear()
    const out = await submitCrossOutletRefund(deps, sub({ orderId: 'o2' }))
    expect(out).toEqual({ kind: 'blocked', message: crossPendingOther('LWB-9') })
    expect(out.kind === 'blocked' && out.message).toBe('Refund #LWB-9 belum terjawab. Buka transaksi itu dulu (Cek transaksi).')
    expect(refundCrossOutlet).not.toHaveBeenCalled()
  })
})

describe('what the server answers after an unsure send (M3, L1)', () => {
  const lost = () => { throw new ApiError(0, 'timeout', 'timeout') }

  it.each([403, 404, 405])('HTTP %i on the FIRST send clears the attempt (nothing was applied)', async (status) => {
    const { storage, deps } = setup({ api: async () => { throw new ApiError(status, 'Tidak diizinkan', 'http') } })
    expect(await submitCrossOutletRefund(deps, sub())).toEqual({ kind: 'refused', message: 'Tidak diizinkan' })
    expect(storage.map.size).toBe(0)
  })

  it.each([403, 404, 405])('HTTP %i AFTER an unanswered send keeps the attempt and says check first', async (status) => {
    let calls = 0
    const { storage, deps } = setup({ api: async () => { calls += 1; if (calls === 1) return lost(); throw new ApiError(status, 'Tidak diizinkan', 'http') } })
    await submitCrossOutletRefund(deps, sub())
    expect(JSON.parse(storage.map.get(KEY) ?? '{}').sends).toBe(1)
    const out = await resendPendingCrossOutletRefund(deps)
    expect(out).toEqual({ kind: 'unsure', message: CROSS_CHECK_FIRST })
    expect(storage.map.size).toBe(1)
    expect(JSON.parse(storage.map.get(KEY) ?? '{}').sends).toBe(2) // counted before the send left
  })

  it.each([400, 409, 413, 422])('HTTP %i clears the attempt even after an unanswered send (body-dependent)', async (status) => {
    let calls = 0
    const { storage, deps } = setup({ api: async () => { calls += 1; if (calls === 1) return lost(); throw new ApiError(status, 'Ditolak', 'http') } })
    await submitCrossOutletRefund(deps, sub())
    expect(await resendPendingCrossOutletRefund(deps)).toEqual({ kind: 'refused', message: 'Ditolak' })
    expect(storage.map.size).toBe(0)
  })

  it('a stored record from before sends were counted is treated as already sent', async () => {
    const { storage, deps } = setup({ api: async () => { throw new ApiError(403, 'x', 'http') } })
    storage.map.set(KEY, JSON.stringify({ uuid: 'u', orderId: 'o1', orderNumber: 'LWB-9', bodyJson: '{}', createdAt: 't' }))
    expect((await resendPendingCrossOutletRefund(deps))?.kind).toBe('unsure')
    expect(storage.map.size).toBe(1)
  })

  it.each([
    ['no body', undefined],
    ['no replayed flag', { ...RESULT, replayed: undefined }],
    ['no refund row', { ...RESULT, refund: undefined }],
    ['no order read-back', { ...RESULT, order: undefined }],
    ['no amount', { ...RESULT, amount: undefined }],
  ])('an invalid 2xx (%s) is unsure and keeps the attempt', async (_n, body) => {
    const { storage, deps } = setup({ api: async () => body as unknown as CrossOutletRefundResult })
    const out = await submitCrossOutletRefund(deps, sub())
    expect(out).toEqual({ kind: 'unsure', message: CROSS_CHECK_FIRST })
    expect(storage.map.size).toBe(1)
  })

  it('an applied outcome names the sale and reason that were actually sent', async () => {
    const { deps } = setup()
    const out = await submitCrossOutletRefund(deps, sub())
    expect(out.kind === 'applied' && out.sent).toEqual({ orderId: 'o1', orderNumber: 'LWB-9', reason: 'Rusak/cacat' })
  })
})

describe('resendPendingCrossOutletRefund', () => {
  it('resends the stored body unchanged, and is a no-op when nothing is pending', async () => {
    let calls = 0
    const { refundCrossOutlet, deps } = setup({
      api: async () => { calls += 1; if (calls === 1) throw new ApiError(504, 'gateway', 'http'); return RESULT },
    })
    expect(await resendPendingCrossOutletRefund(deps)).toBeNull()
    await submitCrossOutletRefund(deps, sub())
    const out = await resendPendingCrossOutletRefund(deps)
    expect(out?.kind).toBe('applied')
    expect(JSON.stringify(refundCrossOutlet.mock.calls[1][1])).toBe(JSON.stringify(refundCrossOutlet.mock.calls[0][1]))
    expect(await resendPendingCrossOutletRefund(deps)).toBeNull()
  })

  it('offline: keeps the attempt and sends nothing', async () => {
    const { storage, refundCrossOutlet, deps } = setup({ api: async () => { throw new ApiError(0, 'net', 'network') } })
    await submitCrossOutletRefund(deps, sub())
    refundCrossOutlet.mockClear()
    const out = await resendPendingCrossOutletRefund({ ...deps, isOnline: false })
    expect(out).toEqual({ kind: 'offline', message: CROSS_OFFLINE_REFUND })
    expect(refundCrossOutlet).not.toHaveBeenCalled()
    expect(storage.map.size).toBe(1)
  })
})
