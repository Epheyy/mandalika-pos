import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { MAX_ATTEMPTS } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

// A37: which redaction tier each engine surface uses, and that the outbox
// item (the retry source of truth) is never touched.
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const PAYLOAD = {
  orderId: 'o-1',
  customerPhone: '081234567890',
  customerName: 'Budi',
  nested: { pin: 'CANARY-PIN', note: 'hubungi 081234567890 / budi@example.com', Authorization: 'Bearer CANARY.JWT' },
}

async function deadLetterEngine(events = {}) {
  const engine = new SyncEngine(api(vi.fn()), events, controllableKV().kv, { actor: null })
  await engine.outbox.add('order', 'dev:1', structuredClone(PAYLOAD))
  for (let i = 0; i < MAX_ATTEMPTS; i++) await engine.outbox.fail('dev:1', 'rejected for budi@example.com 081234567890')
  return engine
}

describe('engine redaction tiers (A37)', () => {
  it('diagnostics and sync log drop secrets AND customer PII, at any depth, without touching the outbox item', async () => {
    const engine = await deadLetterEngine()
    const before = structuredClone(engine.outbox.all())
    const text = engine.buildFailedSyncDiagnostics()
    const log = JSON.stringify(engine.syncLog())
    for (const out of [text, log]) {
      expect(out).not.toContain('CANARY')
      expect(out).not.toContain('081234567890')
      expect(out).not.toContain('Budi')
      expect(out).not.toContain('budi@example.com')
      expect(out).toContain('o-1') // ids stay
    }
    expect(engine.outbox.all()).toEqual(before) // retry payload intact
    expect(engine.outbox.all()[0].payload).toMatchObject({ customerPhone: '081234567890', nested: { pin: 'CANARY-PIN' } })
  })

  it('onDeadLetter hands the app a log-tier payload', async () => {
    const onDeadLetter = vi.fn()
    const engine = await deadLetterEngine({ onDeadLetter })
    ;(engine as unknown as { emitDeadLetters(): void }).emitDeadLetters()
    expect(onDeadLetter).toHaveBeenCalledTimes(1)
    const sent = JSON.stringify(onDeadLetter.mock.calls[0][0])
    expect(sent).not.toContain('CANARY')
    expect(sent).not.toContain('081234567890')
  })

  it('review reports strip nested secrets but keep the customer so head office can resolve the item', async () => {
    const request = vi.fn(async () => ({ data: { resolved: [] } }))
    const engine = new SyncEngine(api(request), {}, controllableKV().kv, { actor: null })
    await engine.outbox.add('order', 'dev:2', structuredClone(PAYLOAD))
    await engine.outbox.settle([{ key: 'dev:2', op: 'review' as const, code: 'forbidden', reason: 'x' }])
    await engine.checkInReviews()
    expect(request).toHaveBeenCalledTimes(1)
    const body = request.mock.calls[0] as unknown as [string, string, { items: { payload: Record<string, unknown> }[] }]
    const sent = JSON.stringify(body[2].items[0].payload)
    expect(sent).not.toContain('CANARY')
    expect(sent).toContain('081234567890')
    expect(sent).toContain('Budi')
    expect(engine.outbox.all().find((i) => i.idempotencyKey === 'dev:2')?.payload).toMatchObject({ customerPhone: '081234567890' })
  })
})
