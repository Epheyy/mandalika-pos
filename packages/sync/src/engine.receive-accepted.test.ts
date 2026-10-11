import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { components } from '@mandalika/api'
import { SyncEngine, type ApiLike } from './engine'
import type { KV } from './storage'

type Transfer = components['schemas']['Transfer']
type BatchResult = components['schemas']['SyncBatchResult']

// ── In-memory KV (no localStorage needed in tests) ─────────────────────────

function memKV(): KV {
  const store = new Map<string, string>()
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value) },
    remove: (key) => { store.delete(key) },
    setDurable: async (key, value) => { store.set(key, value) },
    removeDurable: async (key) => { store.delete(key) },
  }
}

// ── Minimal Transfer fixture ─────────────────────────────────────────────────

const TRANSFER_FIXTURE: Transfer = {
  id: 't1',
  transferNo: 'TRF-2026-00001',
  status: 'completed',
  source: { kind: 'warehouse', id: 'wh1', name: 'Gudang Utama' },
  dest: { kind: 'outlet', id: 'o1', name: 'Gerai Senggigi' },
  items: [],
  createdAt: '2026-01-01T00:00:00Z',
  tandaTerimaNo: 'TT-2026-00001',
}

// ── Minimal pull-bundle so SyncEngine initialises without errors ─────────────

const PULL_BUNDLE = {
  version: 1,
  products: [],
  categories: [],
  bundles: [],
  customers: [],
  promotions: [],
  discountCodes: [],
  loyaltyConditions: [],
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBatchResult(results: BatchResult['results'], version = 1): { data: BatchResult } {
  return { data: { processed: results.length, results, version } }
}

/** Build an ApiLike that echoes the enqueued idempotency key back as the ack
 *  key. The status and transfer payload come from `extraResult`. */
function makeApi(
  statusOverride: 'ok' | 'duplicate',
  transferPayload?: Transfer,
): { api: ApiLike; capturedKey: { value: string } } {
  const capturedKey = { value: '' }
  const api: ApiLike = {
    request: vi.fn().mockImplementation((method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path.includes('/sync/pull')) {
        return Promise.resolve({ data: PULL_BUNDLE })
      }
      if (method === 'POST' && path.includes('/sync/batch')) {
        // Extract the idempotency key from the batch request body
        const b = body as { items: Array<{ idempotencyKey: string }> }
        const key = b.items[0]?.idempotencyKey ?? ''
        capturedKey.value = key
        const result: BatchResult['results'][number] = {
          idempotencyKey: key,
          status: statusOverride,
          orderId: 't1',
          ...(transferPayload ? { tandaTerimaNo: transferPayload.tandaTerimaNo ?? undefined, transfer: transferPayload } : {}),
        }
        return Promise.resolve(makeBatchResult([result]))
      }
      if (method === 'GET' && path.includes('/sync/inbound')) {
        return Promise.resolve({ data: [] })
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    }),
  }
  return { api, capturedKey }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SyncEngine — onReceiveAccepted', () => {
  // In Node.js 24+, `navigator` exists but `navigator.onLine` is `undefined`
  // (falsy), causing SyncEngine's ONLINE() guard to block flush(). Stub it to
  // `true` for every test in this suite.
  beforeEach(() => {
    vi.stubGlobal('navigator', { onLine: true })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fires onReceiveAccepted with the transfer on a fresh ok ack', async () => {
    const { api } = makeApi('ok', TRANSFER_FIXTURE)
    const onReceiveAccepted = vi.fn()
    const engine = new SyncEngine(api, { onReceiveAccepted }, memKV(), { actor: null })

    // Seed the snapshot.
    await engine.resync()

    await engine.enqueueTransferReceive({
      transferId: 't1',
      items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }],
      approverUserId: 'u1',
      pin: '1234',
    })

    // enqueue() fires `void this.flush()` internally. Since ONLINE is now true,
    // the flush runs. Await the explicit flush() call — it returns null
    // (flushing guard) but by the time it resolves the internal flush has
    // completed (Promise microtasks drain before setTimeout/macrotasks).
    await engine.flush()
    await Promise.resolve()

    expect(onReceiveAccepted).toHaveBeenCalledTimes(1)
    expect(onReceiveAccepted).toHaveBeenCalledWith(TRANSFER_FIXTURE)
  })

  it('does NOT fire onReceiveAccepted on a duplicate ack', async () => {
    const { api } = makeApi('duplicate', TRANSFER_FIXTURE)
    const onReceiveAccepted = vi.fn()
    const engine = new SyncEngine(api, { onReceiveAccepted }, memKV(), { actor: null })

    await engine.resync()

    await engine.enqueueTransferReceive({
      transferId: 't1',
      items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }],
      approverUserId: 'u1',
      pin: '1234',
    })

    await engine.flush()
    await Promise.resolve()

    expect(onReceiveAccepted).not.toHaveBeenCalled()
  })

  it('does NOT fire onReceiveAccepted when transfer is absent from the ack', async () => {
    // ok status but no transfer payload — mirrors the backend soft-fail path
    const { api } = makeApi('ok', undefined)
    const onReceiveAccepted = vi.fn()
    const engine = new SyncEngine(api, { onReceiveAccepted }, memKV(), { actor: null })

    await engine.resync()

    await engine.enqueueTransferReceive({
      transferId: 't1',
      items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }],
      approverUserId: 'u1',
      pin: '1234',
    })

    await engine.flush()
    await Promise.resolve()

    expect(onReceiveAccepted).not.toHaveBeenCalled()
  })
})
