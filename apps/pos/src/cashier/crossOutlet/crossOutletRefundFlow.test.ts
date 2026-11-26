import { describe, expect, it, vi } from 'vitest'
import { ApiError, type CrossOutletRefundResult } from '@mandalika/api'
import { createAttemptStore, type AttemptStorage } from './crossOutletAttempt'
import {
  CROSS_CHECK_FIRST, CROSS_OFFLINE_REFUND, CROSS_PENDING_OTHER, CROSS_STORE_FAILED,
  resendPendingCrossOutletRefund, submitCrossOutletRefund, type CrossOutletSubmit,
} from './crossOutletRefundFlow'

const memory = (failWrites = false): AttemptStorage & { map: Map<string, string>; sets: number } => {
  const map = new Map<string, string>()
  const st = {
    map, sets: 0,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { st.sets += 1; if (failWrites) throw new Error('quota'); map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
  }
  return st
}

const sub = (over: Partial<CrossOutletSubmit> = {}, items = [{ lineNo: 0, quantity: 1 }]): CrossOutletSubmit => ({
  orderId: 'o1', orderNumber: 'LWB-9', shiftId: 'sh1', deviceId: 'dev1',
  payload: { items, refundAmount: 50000, reason: 'Rusak/cacat', reasonCode: 'rusak_cacat' }, ...over,
})
const RESULT = { refundId: 'r1', refundState: 'partial', amount: 50000, replayed: false, saleOutletId: 'x', refund: {}, order: {} } as unknown as CrossOutletRefundResult

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
    expect(out).toEqual({ kind: 'blocked', message: CROSS_PENDING_OTHER })
    expect(refundCrossOutlet).not.toHaveBeenCalled()
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
