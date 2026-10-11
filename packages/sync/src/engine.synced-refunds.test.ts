import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { SyncedRefunds, SYNCED_REFUNDS_MAX, SYNCED_REFUNDS_TTL_MS } from './syncedRefunds'
import { controllableKV } from './testFixtures/controllableKV'

// M2: an acknowledged refund leaves the outbox, so the POS must remember it itself: a stale cached
// history row still says "completed" and would offer a second cash payout.

type Body = { items: { type: string; idempotencyKey: string }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const okAll = vi.fn(async (_m: string, _p: string, body: Body) => ({
  data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' })) },
}))
const denyAll = vi.fn(async (_m: string, _p: string, body: Body) => ({
  data: {
    processed: 0, version: 0,
    results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'x', code: 'conflict', retryable: false })),
  },
}))

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T03:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function ackRefund(request: unknown, kv = controllableKV().kv, orderId = 'o1') {
  const engine = new SyncEngine(api(request), {}, kv, { actor: null })
  await engine.enqueue('refund', { orderId, reason: 'rusak' })
  vi.stubGlobal('navigator', { onLine: true })
  await engine.flushNow()
  vi.stubGlobal('navigator', { onLine: false })
  return { engine, kv }
}

describe('engine remembers acknowledged refunds', () => {
  it('records the order of a refund once it is acknowledged', async () => {
    const { engine } = await ackRefund(okAll)
    expect(engine.queuedRefundOrderIds().size).toBe(0)
    expect([...engine.syncedRefundOrderIds()]).toEqual(['o1'])
  })
  it('survives an app restart (new engine on the same storage)', async () => {
    const { kv } = await ackRefund(okAll)
    const again = new SyncEngine(api(okAll), {}, kv, { actor: null })
    expect(again.syncedRefundOrderIds().has('o1')).toBe(true)
  })
  it('does not record refused or parked refunds, or other item types', async () => {
    const { engine } = await ackRefund(denyAll)
    expect(engine.syncedRefundOrderIds().size).toBe(0)
    const kv = controllableKV().kv
    const e2 = new SyncEngine(api(okAll), {}, kv, { actor: null })
    await e2.enqueue('order', { orderId: 'o9', total: 1 })
    vi.stubGlobal('navigator', { onLine: true })
    await e2.flushNow()
    expect(e2.syncedRefundOrderIds().size).toBe(0)
  })
})

describe('SyncedRefunds store is bounded', () => {
  const store = () => new SyncedRefunds(controllableKV().kv)
  it('keeps only the newest SYNCED_REFUNDS_MAX entries', () => {
    const s = store()
    for (let i = 0; i < SYNCED_REFUNDS_MAX + 5; i++) s.add(`o${i}`)
    const ids = s.ids()
    expect(ids.size).toBe(SYNCED_REFUNDS_MAX)
    expect(ids.has('o0')).toBe(false)
    expect(ids.has(`o${SYNCED_REFUNDS_MAX + 4}`)).toBe(true)
  })
  it('drops entries older than the retention window', () => {
    const s = store()
    s.add('old')
    vi.setSystemTime(Date.now() + SYNCED_REFUNDS_TTL_MS + 1000)
    s.add('new')
    expect([...s.ids()]).toEqual(['new'])
  })
  it('is empty and safe on corrupt storage', () => {
    const { kv } = controllableKV({ 'mandalika.pos.syncedRefunds': '{broken' })
    expect(new SyncedRefunds(kv).ids().size).toBe(0)
  })
  it('does not duplicate an order recorded twice', () => {
    const s = store()
    s.add('o1'); s.add('o1')
    expect(s.ids().size).toBe(1)
  })
})
