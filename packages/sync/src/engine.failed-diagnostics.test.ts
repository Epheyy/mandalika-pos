import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_TIMEOUT_MS, SyncEngine } from './engine'
import { MAX_ATTEMPTS, Outbox } from './outbox'
import type { KV } from './storage'

// Successful synchronous test storage, reused on reconstruction. This is not
// evidence of Android Preferences durability (A01).
async function fixture(count = 2) {
  const store = new Map<string, string>()
  const kv: KV = {
    get: (key) => store.get(key) ?? null,
    set: vi.fn((key, value) => { store.set(key, value) }),
    remove: vi.fn((key) => { store.delete(key) }),
    setDurable: vi.fn(async (key, value) => { store.set(key, value) }),
    removeDurable: vi.fn(async (key) => { store.delete(key) }),
  }
  const request = vi.fn().mockRejectedValue(new Error('unexpected request'))
  const onOutboxChange = vi.fn()
  const engine = new SyncEngine({ request }, { onOutboxChange }, kv)
  for (let i = 0; i < count; i++) {
    const key = `synthetic-device:operation-${i}`
    await engine.outbox.add(i % 2 ? 'refund' : 'order', key, {
      orderId: `synthetic-sale-${i}`,
      items: [{ productId: 'synthetic-product', quantity: 1, metadata: { marker: 'keep-original' } }],
      pin: 'SYNTHETIC-PIN-NOT-A-CREDENTIAL',
    })
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await engine.outbox.fail(key, `synthetic rejection ${attempt + 1}`)
    }
  }
  return { engine, kv, store, request, onOutboxChange }
}

function freezeDeep(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep)
    Object.freeze(value)
  }
}

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('A02-export: failed diagnostic retention', () => {
  it('exports twice without changing sale/refund identity, payload, attempts, errors or stored state (D03 corrected)', async () => {
    const { engine, kv, store, request, onOutboxChange } = await fixture()
    const before = structuredClone(engine.outbox.all())
    const storedBefore = store.get('mandalika.pos.outbox')
    const failedBefore = engine.deadLettered()
    // Seeding went through setDurable; only writes made BY the export count below.
    vi.mocked(kv.setDurable).mockClear()
    vi.mocked(kv.removeDurable).mockClear()

    const first = engine.buildFailedSyncDiagnostics()
    const second = engine.buildFailedSyncDiagnostics()

    expect(engine.outbox.all()).toEqual(before)
    expect(store.get('mandalika.pos.outbox')).toBe(storedBefore)
    expect(engine.deadLettered()).toEqual(failedBefore)
    expect(engine.pendingCount()).toBe(0) // parked is not automatically retryable
    expect(first).toBe(second)
    expect(JSON.parse(first)).toHaveLength(2)
    expect(new Outbox(kv).all()).toEqual(before)
    const reconstructed = new SyncEngine({ request }, {}, kv)
    expect(reconstructed.deadLettered()).toEqual(failedBefore)
    expect(reconstructed.buildFailedSyncDiagnostics()).toBe(first)
    expect(onOutboxChange).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(kv.remove).not.toHaveBeenCalled()
    expect(kv.setDurable).not.toHaveBeenCalled()
    expect(kv.removeDurable).not.toHaveBeenCalled()
  })

  it('redacts detached diagnostics while frozen nested operations remain untouched', async () => {
    const { engine, store } = await fixture()
    const before = structuredClone(engine.outbox.all())
    const storedBefore = store.get('mandalika.pos.outbox')
    freezeDeep(engine.outbox.all())
    const mutations = [
      vi.spyOn(engine.outbox, 'ack'), vi.spyOn(engine.outbox, 'fail'),
      vi.spyOn(engine.outbox, 'prune'), vi.spyOn(engine.outbox, 'discard'),
      vi.spyOn(engine.outbox, 'retryDeadLettered'), vi.spyOn(engine.outbox, 'add'),
      vi.spyOn(engine.outbox, 'settle'),
    ]

    const text = engine.buildFailedSyncDiagnostics()
    expect(text).not.toContain('SYNTHETIC-PIN-NOT-A-CREDENTIAL')
    const exported = JSON.parse(text)
    expect(exported[0].payload.items[0].metadata.marker).toBe('keep-original')
    exported[0].payload.items[0].metadata.marker = 'changed-export'
    const log = engine.syncLog() as Array<{ payload: Record<string, unknown> }>
    expect(JSON.stringify(log)).not.toContain('SYNTHETIC-PIN-NOT-A-CREDENTIAL')
    log[0].payload.items = []
    expect(engine.outbox.all()).toEqual(before)
    expect(store.get('mandalika.pos.outbox')).toBe(storedBefore)
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled())
  })

  it('caps only the support log, retaining all operations through large repeated exports', async () => {
    const { engine, kv, store } = await fixture(205)
    const before = structuredClone(engine.outbox.all())
    const storedBefore = store.get('mandalika.pos.outbox')
    for (let i = 0; i < 3; i++) {
      expect(JSON.parse(engine.buildFailedSyncDiagnostics())).toHaveLength(205)
      expect(engine.syncLog()).toHaveLength(200)
      expect(engine.outbox.all()).toEqual(before)
      expect(store.get('mandalika.pos.outbox')).toBe(storedBefore)
    }
    expect(new Outbox(kv).all()).toEqual(before)
  })

  it('manual retry after export uses the original operation keys and original unredacted payloads', async () => {
    const { engine, request } = await fixture()
    const before = structuredClone(engine.outbox.all())
    engine.buildFailedSyncDiagnostics()
    request.mockResolvedValue({ data: {
      results: before.map((item) => ({ idempotencyKey: item.idempotencyKey, status: 'ok' })),
      processed: before.length, version: 0,
    } })
    await engine.retryFailed()
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/api/v1/sync/batch', {
      items: before.map(({ type, idempotencyKey, payload }) => ({ type, idempotencyKey, payload })),
    }, { timeoutMs: BATCH_TIMEOUT_MS })
    await vi.waitFor(() => expect(engine.outbox.all()).toEqual([]))
  })

  it('exporting an empty failed set neither writes nor starts delivery', async () => {
    const { engine, kv, request } = await fixture(0)
    vi.mocked(kv.set).mockClear()
    vi.mocked(kv.setDurable).mockClear()
    expect(engine.buildFailedSyncDiagnostics()).toBe('[]')
    expect(kv.set).not.toHaveBeenCalled()
    expect(kv.remove).not.toHaveBeenCalled()
    expect(kv.setDurable).not.toHaveBeenCalled()
    expect(kv.removeDurable).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
})
