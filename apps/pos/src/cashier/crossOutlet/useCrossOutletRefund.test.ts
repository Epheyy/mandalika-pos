import { describe, expect, it, vi } from 'vitest'
import type { KV } from '@mandalika/sync'
import { ApiError, type CrossOutletOrder, type CrossOutletRefundResult } from '@mandalika/api'
import { createSubmitGate } from '../../lib/durableSubmit'
import { createAttemptStore } from './crossOutletAttempt'
import { createCrossOutletController, isCrossAttemptPendingFor, routeRefund, type Options, type PendingRef } from './useCrossOutletRefund'

const memoryKv = (): KV => {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v) }, remove: (k) => { map.delete(k) },
    setDurable: async (k, v) => { map.set(k, v) }, removeDurable: async (k) => { map.delete(k) },
  }
}
const order = (id: string, no: string) => ({ id, orderNumber: no, outletId: 'x' }) as never
const payload = { items: [{ lineNo: 0, quantity: 1 }], refundAmount: 1000, reason: 'Rusak', reasonCode: 'rusak' } as never
const resultFor = (id: string, no: string) =>
  ({ refundId: 'r', refundState: 'partial', amount: 1000, replayed: false, saleOutletId: 'x', refund: {}, order: { outletName: 'L', order: { id, orderNumber: no } } }) as unknown as CrossOutletRefundResult

function setup(refund: (id: string) => Promise<CrossOutletRefundResult>, lookup?: () => Promise<CrossOutletOrder[]>) {
  const state = { error: null as string | null, busy: false, pending: null as PendingRef | null, origin: null as string | null }
  const o: Options = {
    api: { refundCrossOutlet: vi.fn(refund), crossOutletLookup: vi.fn(lookup ?? (async () => [])) } as never,
    isOnline: true, deviceId: 'd', gate: createSubmitGate(), onApplied: vi.fn(), onOrderRefreshed: vi.fn(),
  }
  const store = createAttemptStore(memoryKv())
  const ctl = createCrossOutletController(() => o, store, {
    setOriginName: (v) => { state.origin = v }, setError: (v) => { state.error = v },
    setBusy: (v) => { state.busy = v }, setPending: (v) => { state.pending = v },
  })
  return { o, state, store, ctl }
}
const lost = () => Promise.reject(new ApiError(0, 'timeout', 'timeout'))
const submit = (ctl: ReturnType<typeof setup>['ctl'], id: string, no: string) =>
  ctl.submit({ order: order(id, no), payload, shiftId: 's' })

describe('isCrossAttemptPendingFor', () => {
  it('matches a stored cross attempt by any of the order ids', () => {
    const p = { orderId: 'o1', orderNumber: 'LWB-1' }
    expect(isCrossAttemptPendingFor(p, ['uuid-x', 'o1'])).toBe(true)
    expect(isCrossAttemptPendingFor(p, ['o2'])).toBe(false)
    expect(isCrossAttemptPendingFor(null, ['o1'])).toBe(false)
  })
})

describe('routeRefund', () => {
  it('sends only a sale of a known, different outlet to the server; everything else keeps the outbox', () => {
    expect(routeRefund({ outletId: 'x' }, 'y')).toBe('cross')
    expect(routeRefund({ outletId: 'y' }, 'y')).toBe('outbox')
    expect(routeRefund({ outletId: '' }, 'y')).toBe('outbox')
    expect(routeRefund({ outletId: 'x' }, null)).toBe('outbox')
    expect(routeRefund({ outletId: 'x' }, undefined)).toBe('outbox')
    expect(routeRefund(null, 'y')).toBe('outbox')
  })
})

describe('cross-outlet controller', () => {
  it('a double tap sends once and the second tap leaves the busy flag to the first send', async () => {
    let release: (r: CrossOutletRefundResult) => void = () => {}
    const { o, state, ctl } = setup(() => new Promise((res) => { release = res }))
    const first = submit(ctl, 'o1', 'LWB-1')
    await Promise.resolve()
    expect(state.busy).toBe(true)
    await submit(ctl, 'o1', 'LWB-1') // second tap while the first is in flight
    expect(state.busy).toBe(true)
    expect(o.api.refundCrossOutlet).toHaveBeenCalledTimes(1)
    release(resultFor('o1', 'LWB-1'))
    await first
    expect(state.busy).toBe(false)
    expect(o.onApplied).toHaveBeenCalledTimes(1)
    expect(vi.mocked(o.onApplied).mock.calls[0][3]).toEqual({ orderId: 'o1', orderNumber: 'LWB-1', reason: 'Rusak' })
  })

  it('an unsure answer shows the check-first copy and exposes the pending attempt', async () => {
    const { state, ctl } = setup(lost)
    await submit(ctl, 'o1', 'LWB-1')
    expect(state.error).toContain('Cek dulu')
    expect(state.pending).toEqual({ orderId: 'o1', orderNumber: 'LWB-1' })
    expect(state.busy).toBe(false)
  })

  it('H1: a refund of another sale is blocked while one is unanswered, and nothing is sent', async () => {
    const { o, state, ctl } = setup(lost)
    await submit(ctl, 'o1', 'LWB-1')
    vi.mocked(o.api.refundCrossOutlet).mockClear()
    await submit(ctl, 'o2', 'LWB-2')
    expect(o.api.refundCrossOutlet).not.toHaveBeenCalled()
    expect(state.error).toBe('Refund #LWB-1 belum terjawab. Buka transaksi itu dulu (Cek transaksi).')
  })

  it('H1: a resend reports the sale that was actually sent', async () => {
    let calls = 0
    const { o, ctl } = setup(() => { calls += 1; return calls === 1 ? lost() : Promise.resolve(resultFor('o1', 'LWB-1')) })
    await submit(ctl, 'o1', 'LWB-1')
    await ctl.resend()
    const [result, message, , sent] = vi.mocked(o.onApplied).mock.calls[0]
    expect(result.order.order.id).toBe('o1')
    expect(message).toContain('LWB-1')
    expect(sent.orderId).toBe('o1')
  })

  it('resend while sale B is open resends the stored body of sale A (same uuid, bytes) and names A', async () => {
    let calls = 0
    const { o, state, store, ctl } = setup(() => { calls += 1; return calls === 1 ? lost() : Promise.resolve(resultFor('o1', 'LWB-1')) })
    await submit(ctl, 'o1', 'LWB-1')
    const first = store.read()
    await ctl.resend() // dialog shows sale B (o2); resend takes no sale argument
    const [bodyA, bodyB] = vi.mocked(o.api.refundCrossOutlet).mock.calls.map((c) => JSON.stringify(c[1]))
    expect(bodyB).toBe(bodyA)
    expect(vi.mocked(o.api.refundCrossOutlet).mock.calls[1][0]).toBe('o1')
    expect(JSON.parse(first!.bodyJson).clientRefundUuid).toBe(JSON.parse(bodyB).clientRefundUuid)
    expect(vi.mocked(o.onApplied).mock.calls[0][3].orderId).toBe('o1')
    expect(store.read()).toBeNull()
    expect(state.pending).toBeNull()
  })

  it('resend settles a definite refusal (cancelled sale) so the tablet is not stuck', async () => {
    let calls = 0
    const { o, state, store, ctl } = setup(() => { calls += 1; return calls === 1 ? lost() : Promise.reject(new ApiError(409, 'Pesanan sudah dibatalkan', 'http')) })
    await submit(ctl, 'o1', 'LWB-1')
    expect(store.read()?.sends).toBe(1)
    await ctl.resend()
    expect(o.onApplied).not.toHaveBeenCalled()
    expect(state.error).toBe('Pesanan sudah dibatalkan')
    expect(store.read()).toBeNull()
    expect(state.pending).toBeNull()
  })

  it('resend counts the send before it leaves (sends 1 to 2)', async () => {
    const { store, ctl } = setup(lost)
    await submit(ctl, 'o1', 'LWB-1')
    await ctl.resend()
    expect(store.read()?.sends).toBe(2)
  })

  it('H1: "Cek transaksi" looks up the pending sale, not the displayed one, and opens it', async () => {
    const hit = { outletName: 'Lewiliang', order: { id: 'o1', orderNumber: 'LWB-1' } } as unknown as CrossOutletOrder
    const { o, state, ctl } = setup(lost, async () => [hit])
    await submit(ctl, 'o1', 'LWB-1')
    await ctl.check(order('o2', 'LWB-2'))
    expect(o.api.crossOutletLookup).toHaveBeenCalledWith({ orderNumber: 'LWB-1' })
    expect(o.onOrderRefreshed).toHaveBeenCalledWith(hit.order)
    expect(state.origin).toBe('Lewiliang')
  })

  it('M1: reset clears only the UI; the unsure attempt stays in storage and is offered again', async () => {
    const { state, store, ctl } = setup(lost)
    await submit(ctl, 'o1', 'LWB-1')
    ctl.reset()
    expect(state.error).toBeNull()
    expect(state.origin).toBeNull()
    expect(store.read()?.orderId).toBe('o1')
    expect(state.pending).toEqual({ orderId: 'o1', orderNumber: 'LWB-1' })
  })
})
