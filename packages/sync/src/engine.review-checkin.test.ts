import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVIEW_CHECKIN_MAX_ITEMS, REVIEW_CHECKIN_MS, REVIEW_CHECKIN_NEW_MS, SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

type ReportBody = { items: { idempotencyKey: string; payload: Record<string, unknown>; capturedOutletId?: string }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const resolvedReply = (keys: string[]) => ({
  data: { resolved: keys.map((idempotencyKey) => ({ idempotencyKey, resolvedAt: '2026-10-12T04:00:00Z', resolvedByName: 'HO', note: 'refund manual' })) },
})

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T03:00:00Z'))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function parked(request: unknown, keys: string[], events = {}, kvOverride?: ReturnType<typeof controllableKV>['kv']) {
  const kv = kvOverride ?? controllableKV().kv
  const engine = new SyncEngine(api(request), events, kv, { actor: null })
  for (const k of keys) await engine.outbox.add('transfer_receive', k, { transferId: 't1', pin: '1234' })
  await engine.outbox.settle(keys.map((key) => ({ key, op: 'review' as const, code: 'forbidden', reason: 'PIN salah' })))
  return engine
}

describe('SyncEngine.checkInReviews', () => {
  it('does nothing with no review items or while offline', async () => {
    const request = vi.fn()
    const engine = await parked(request, [])
    await engine.checkInReviews()
    vi.stubGlobal('navigator', { onLine: false })
    const offline = await parked(request, ['d:1'])
    await offline.checkInReviews()
    expect(request).not.toHaveBeenCalled()
  })

  it('reports redacted items, marks them reported, then throttles for 5 minutes', async () => {
    const request = vi.fn(async () => resolvedReply([]))
    const engine = await parked(request, ['d:1'])
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(1)
    const [method, path, body] = request.mock.calls[0] as unknown as [string, string, ReportBody]
    expect([method, path]).toEqual(['POST', '/api/v1/sync/review-items'])
    expect(body.items[0].idempotencyKey).toBe('d:1')
    expect(body.items[0].payload).not.toHaveProperty('pin')
    expect(engine.isReviewReported('d:1')).toBe(true)
    await engine.checkInReviews()
    vi.advanceTimersByTime(REVIEW_CHECKIN_MS - 1000)
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('a new unreported item shortens the wait to 30 seconds', async () => {
    const request = vi.fn(async () => resolvedReply([]))
    const engine = await parked(request, ['d:1'])
    await engine.checkInReviews()
    await engine.outbox.add('order', 'd:2', { total: 1 })
    await engine.outbox.settle([{ key: 'd:2', op: 'review', code: 'rejected', reason: 'x' }])
    vi.advanceTimersByTime(REVIEW_CHECKIN_NEW_MS)
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('removes resolved items, fires onReviewResolved and writes the sync log', async () => {
    const onReviewResolved = vi.fn()
    const engine = await parked(vi.fn(async () => resolvedReply(['d:1'])), ['d:1', 'd:2'], { onReviewResolved })
    await engine.checkInReviews()
    expect(engine.reviewItems().map((i) => i.idempotencyKey)).toEqual(['d:2'])
    expect(onReviewResolved).toHaveBeenCalledWith([{ idempotencyKey: 'd:1', type: 'transfer_receive', note: 'refund manual', resolvedByName: 'HO' }])
    expect(JSON.stringify(engine.syncLog())).toContain('diselesaikan kantor pusat')
  })

  it('a failed or malformed reply changes nothing', async () => {
    for (const request of [vi.fn(async () => { throw new Error('offline') }), vi.fn(async () => ({ data: {} }))]) {
      const engine = await parked(request, ['d:1'])
      await engine.checkInReviews()
      expect(engine.reviewItems().map((i) => i.idempotencyKey)).toEqual(['d:1'])
      expect(engine.isReviewReported('d:1')).toBe(false)
    }
  })

  it('does not remove an item the cashier re-queued while the check-in was in flight', async () => {
    let release!: (v: unknown) => void
    const engine = await parked(vi.fn(() => new Promise((r) => { release = r })), ['d:1'])
    const run = engine.checkInReviews()
    await engine.outbox.retryDeadLettered() // "Coba lagi" during the request
    release(resolvedReply(['d:1']))
    await run
    expect(engine.outbox.pending().map((i) => i.idempotencyKey)).toEqual(['d:1'])
  })

  it('rotates through more than 50 items so every one is reported and resolved', async () => {
    const keys = Array.from({ length: REVIEW_CHECKIN_MAX_ITEMS + 10 }, (_, i) => `d:${String(i).padStart(3, '0')}`)
    const sent = new Set<string>()
    const request = vi.fn(async (_m: string, _p: string, body: ReportBody) => {
      body.items.forEach((i) => sent.add(i.idempotencyKey))
      expect(body.items.length).toBeLessThanOrEqual(REVIEW_CHECKIN_MAX_ITEMS)
      return resolvedReply([])
    })
    const engine = await parked(request, keys)
    await engine.checkInReviews()
    vi.advanceTimersByTime(REVIEW_CHECKIN_NEW_MS)
    await engine.checkInReviews()
    expect(sent.size).toBe(keys.length)
    // All reported now: the next round (5 min later) re-sends the least recently sent first.
    request.mockImplementation(async (_m: string, _p: string, body: ReportBody) => resolvedReply(body.items.map((i) => i.idempotencyKey)))
    vi.advanceTimersByTime(REVIEW_CHECKIN_MS)
    await engine.checkInReviews()
    vi.advanceTimersByTime(REVIEW_CHECKIN_MS)
    await engine.checkInReviews()
    expect(engine.reviewItems()).toEqual([])
  })

  it('start() checks in on its timer, but never in flushOnly mode', async () => {
    const request = vi.fn(async (_m: string, path: string) =>
      path.endsWith('/sync/review-items') ? resolvedReply([]) : { data: [] })
    const engine = await parked(request, ['d:1'])
    const stop = engine.start(12_000, { flushOnly: true })
    await vi.advanceTimersByTimeAsync(13_000)
    stop()
    expect(request.mock.calls.some((c) => String(c[1]).endsWith('/sync/review-items'))).toBe(false)
    const stop2 = engine.start(12_000)
    await vi.advanceTimersByTimeAsync(13_000)
    stop2()
    expect(request.mock.calls.some((c) => String(c[1]).endsWith('/sync/review-items'))).toBe(true)
  })

  it('replies with a malformed element are ignored entirely (not marked reported)', async () => {
    const engine = await parked(vi.fn(async () => ({ data: { resolved: [null] } })), ['d:1'])
    await engine.checkInReviews()
    expect(engine.isReviewReported('d:1')).toBe(false)
    expect(engine.reviewItems().map((i) => i.idempotencyKey)).toEqual(['d:1'])
  })

  it('retryFailed clears the reported stamp so a re-parked item counts as new', async () => {
    const engine = await parked(vi.fn(async () => resolvedReply([])), ['d:1'])
    await engine.checkInReviews()
    expect(engine.isReviewReported('d:1')).toBe(true)
    await engine.retryFailed()
    expect(engine.isReviewReported('d:1')).toBe(false)
  })

  it('still notifies when resolveReviewed rejects but the removal had landed', async () => {
    const onReviewResolved = vi.fn()
    const engine = await parked(vi.fn(async () => resolvedReply(['d:1'])), ['d:1'], { onReviewResolved })
    const real = engine.outbox.resolveReviewed.bind(engine.outbox)
    vi.spyOn(engine.outbox, 'resolveReviewed').mockImplementation(async (keys) => {
      await real(keys)
      throw new Error('write failed after landing')
    })
    await engine.checkInReviews()
    expect(engine.reviewItems()).toEqual([])
    expect(onReviewResolved).toHaveBeenCalledWith([{ idempotencyKey: 'd:1', type: 'transfer_receive', note: 'refund manual', resolvedByName: 'HO' }])
  })

  it('does not notify when resolveReviewed rejects and the item is still parked', async () => {
    const onReviewResolved = vi.fn()
    const handle = controllableKV()
    const engine = await parked(vi.fn(async () => resolvedReply(['d:1'])), ['d:1'], { onReviewResolved }, handle.kv)
    handle.ctl.mode = 'reject'
    await engine.checkInReviews()
    expect(engine.reviewItems().map((i) => i.idempotencyKey)).toEqual(['d:1'])
    expect(onReviewResolved).not.toHaveBeenCalled()
  })

  it('does not announce an item re-queued during the check-in when the removal write is rejected', async () => {
    const onReviewResolved = vi.fn()
    const handle = controllableKV()
    let release!: (v: unknown) => void
    const request = vi.fn(() => new Promise((r) => { release = r }))
    const engine = new SyncEngine(api(request), { onReviewResolved }, handle.kv, {
      actor: () => ({ outletId: 'outlet-a', userId: 'user-a', shiftId: null }),
    })
    const envelope = (userId: string) => ({ v: 1 as const, outletId: 'outlet-a', userId, deviceId: 'dev', capturedAt: '2026-10-12T03:00:00Z' })
    await engine.outbox.add('transfer_receive', 'd:1', { transferId: 't1', pin: '1234' }, envelope('user-a'))
    await engine.outbox.add('transfer_receive', 'd:2', { transferId: 't2', pin: '1234' }, envelope('user-b'))
    await engine.outbox.settle(['d:1', 'd:2'].map((key) => ({ key, op: 'review' as const, code: 'forbidden', reason: 'PIN salah' })))
    // The reply lands; the snapshot (d:1, d:2 parked) is taken. Then, inside the removal's
    // window, "Coba lagi" re-queues the actor's own d:1 and the removal commit rejects.
    const real = engine.outbox.resolveReviewed.bind(engine.outbox)
    vi.spyOn(engine.outbox, 'resolveReviewed').mockImplementation(async (keys) => {
      await engine.outbox.retryDeadLettered((i) => i.envelope?.userId === 'user-a') // d:2 is foreign, stays parked
      handle.ctl.mode = 'reject' // removal of d:2 now rejects without landing
      return real(keys)
    })
    const run = engine.checkInReviews()
    release(resolvedReply(['d:1', 'd:2']))
    await run
    const all = engine.outbox.all()
    expect(all.find((i) => i.idempotencyKey === 'd:1')?.status).toBe('pending')
    const announced = onReviewResolved.mock.calls.flatMap((c) => (c[0] as { idempotencyKey: string }[]).map((n) => n.idempotencyKey))
    expect(announced).not.toContain('d:1')
    expect(JSON.stringify(engine.syncLog())).not.toContain('diselesaikan kantor pusat')
  })

  it('a failing sync-log write cannot suppress the notice', async () => {
    const onReviewResolved = vi.fn()
    const { kv } = controllableKV()
    const engine = await parked(vi.fn(async () => resolvedReply(['d:1'])), ['d:1'], { onReviewResolved }, {
      ...kv,
      set: (key: string, value: string) => {
        if (key === 'mandalika.pos.synclog') throw new Error('QuotaExceededError (synthetic)')
        kv.set(key, value)
      },
    })
    await engine.checkInReviews()
    expect(engine.reviewItems()).toEqual([])
    expect(onReviewResolved).toHaveBeenCalledTimes(1)
  })
})
