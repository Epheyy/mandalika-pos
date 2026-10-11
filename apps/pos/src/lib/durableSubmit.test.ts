import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type KV } from '@mandalika/sync'
import { createSubmitGate, notSavedMessage } from './durableSubmit'

// Memory KV whose durable write can be failed or held, like a full/slow disk.
function fixture() {
  const store = new Map<string, string>()
  const ctl = { failWrites: false, held: [] as Array<() => void> }
  const kv: KV = {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value) },
    remove: (key) => { store.delete(key) },
    setDurable: (key, value) => {
      if (ctl.failWrites) return Promise.reject(new Error('QuotaExceededError (synthetic)'))
      return new Promise<void>((resolve) => {
        const commit = () => { store.set(key, value); resolve() }
        ctl.held.push(commit)
      })
    },
    removeDurable: async (key) => { store.delete(key) },
  }
  const request = vi.fn().mockRejectedValue(new Error('offline'))
  const engine = new SyncEngine({ request }, {}, kv, { actor: null })
  return { engine, ctl, request }
}

beforeEach(() => { vi.stubGlobal('navigator', { onLine: false }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('sale/refund/shift submit gate over a real SyncEngine', () => {
  it('does not report success or let the UI clear state when the enqueue write rejects', async () => {
    const { engine, ctl, request } = fixture()
    ctl.failWrites = true
    const onSaved = vi.fn()
    const gate = createSubmitGate()
    const outcome = await gate.run(() => engine.enqueue('order', { total: 100000 }))
    if (outcome.status === 'saved') onSaved()
    expect(outcome.status).toBe('failed')
    expect(onSaved).not.toHaveBeenCalled() // no success screen / cart reset / print
    expect(engine.outbox.all()).toEqual([])
    expect(engine.pendingCount()).toBe(0)
    expect(request).not.toHaveBeenCalled()
    expect(notSavedMessage('Transaksi')).toBe('Transaksi BELUM tersimpan di perangkat. Coba lagi.')
    // The gate is released after a failure so the cashier can retry.
    ctl.failWrites = false
    const retry = gate.run(() => engine.enqueue('order', { total: 100000 }))
    await vi.waitFor(() => expect(ctl.held).toHaveLength(1))
    ctl.held.shift()!()
    expect((await retry).status).toBe('saved')
    expect(engine.outbox.all()).toHaveLength(1)
  })

  it('a double tap while the write is in flight creates exactly one item', async () => {
    const { engine, ctl } = fixture()
    const gate = createSubmitGate()
    const tap = () => gate.run(() => engine.enqueue('order', { total: 100000 }))
    const first = tap()
    const second = tap() // same tick, before the first write resolves
    expect(gate.isBusy()).toBe(true)
    expect(await second).toEqual({ status: 'busy' })
    await vi.waitFor(() => expect(ctl.held).toHaveLength(1))
    ctl.held.shift()!()
    expect((await first).status).toBe('saved')
    expect(gate.isBusy()).toBe(false)
    expect(engine.outbox.all()).toHaveLength(1)
    expect(ctl.held).toHaveLength(0)
  })

  it('refund and shift ops are single-flight through the same gate', async () => {
    const { engine, ctl } = fixture()
    const gate = createSubmitGate()
    const a = gate.run(() => engine.enqueue('refund', { orderId: 'o1', reason: 'r' }))
    const b = gate.run(() => engine.enqueue('shift_close', { shiftId: 's1', closingCash: 0 }))
    expect((await b).status).toBe('busy')
    await vi.waitFor(() => expect(ctl.held).toHaveLength(1))
    ctl.held.shift()!()
    await a
    expect(engine.outbox.all().map((i) => i.type)).toEqual(['refund'])
  })
})
