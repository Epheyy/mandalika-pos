import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ActorContext, type ApiLike } from './engine'
import { MAX_ATTEMPTS } from './outbox'
import { OFFLINE_CONTACT_KEY } from './offlineContact'
import { controllableKV } from './testFixtures/controllableKV'

const H = 3_600_000
type Err = Error & { status?: number; kind?: string }
const apiError = (status: number, kind = 'http'): Err => Object.assign(new Error('http'), { status, kind })
const actor: ActorContext = { outletId: 'outlet-a', userId: 'user-a' }
const T0 = Date.parse('2026-10-19T08:00:00Z')

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function make(request: unknown) {
  const { kv } = controllableKV()
  const engine = new SyncEngine({ request: request as ApiLike['request'] }, {}, kv, { actor: () => actor })
  return { engine, kv }
}
const versionOk = (contact?: { at: string; sig: string }) => ({ data: { version: 0, dataManifest: {}, ...(contact ? { contact } : {}) } })

async function enqueueOffline(engine: SyncEngine) {
  vi.stubGlobal('navigator', { onLine: false }) // no auto flush
  await engine.enqueue('order', { total: 1 })
  vi.stubGlobal('navigator', { onLine: true })
  const items = engine.outbox.all()
  return items[items.length - 1]
}

describe('offline-cap evidence (A05)', () => {
  it('asks /sync/version for a contact with this device id', async () => {
    const request = vi.fn().mockResolvedValue(versionOk())
    const { engine } = make(request)
    await engine.checkVersion()
    expect(request).toHaveBeenCalledWith('GET', `/api/v1/sync/version?deviceId=${encodeURIComponent(engine.deviceId)}`)
  })

  it('a 2xx version check with a signed contact stamps it on later items, with the offline time', async () => {
    const contact = { at: '2026-10-19T08:00:00.500Z', sig: 'sig-1' }
    const { engine } = make(vi.fn().mockResolvedValue(versionOk(contact)))
    await engine.checkVersion()
    vi.setSystemTime(new Date(T0 + 3 * H))
    const item = await enqueueOffline(engine)
    expect(item.envelope).toMatchObject({ v: 1, contact, contactDeviceAt: T0, offlineMs: 3 * H })
  })

  it('a 2xx without a contact (old server) records an unsigned contact', async () => {
    const { engine } = make(vi.fn().mockResolvedValue(versionOk()))
    await engine.checkVersion()
    vi.setSystemTime(new Date(T0 + H))
    const item = await enqueueOffline(engine)
    expect(item.envelope).toMatchObject({ v: 1, contactDeviceAt: T0, offlineMs: H })
    expect(item.envelope).not.toHaveProperty('contact')
  })

  it.each([
    ['4xx (reachable, account refused)', apiError(403)],
    ['5xx', apiError(503)],
    ['network failure', new TypeError('offline')],
    ['timeout', apiError(0, 'timeout')],
    ['401', apiError(401)],
  ])('%s is NOT a contact', async (_n, err) => {
    const { engine, kv } = make(vi.fn().mockRejectedValue(err))
    await engine.checkVersion()
    expect(kv.get(OFFLINE_CONTACT_KEY)).toBeNull()
    expect(engine.offlineState().level).toBe('unknown')
    const item = await enqueueOffline(engine)
    expect(item.envelope).not.toHaveProperty('offlineMs')
    expect(item.envelope).not.toHaveProperty('contactDeviceAt')
  })

  it('a 4xx after a good contact does not refresh it', async () => {
    const request = vi.fn().mockResolvedValueOnce(versionOk({ at: 'a', sig: 's' })).mockRejectedValue(apiError(403))
    const { engine } = make(request)
    await engine.checkVersion()
    vi.setSystemTime(new Date(T0 + 11 * H))
    await engine.checkVersion()
    expect(engine.offlineState().level).toBe('warn')
  })

  it('a resync (/sync/pull 2xx) records an unsigned contact', async () => {
    const request = vi.fn().mockResolvedValue({ data: { version: 3, products: [] } })
    const { engine } = make(request)
    await engine.resync()
    vi.setSystemTime(new Date(T0 + 2 * H))
    const item = await enqueueOffline(engine)
    expect(item.envelope).toMatchObject({ contactDeviceAt: T0, offlineMs: 2 * H })
    expect(item.envelope).not.toHaveProperty('contact')
  })

  it('offlineState walks ok -> warn -> locked and unknown before any contact', async () => {
    const { engine } = make(vi.fn().mockResolvedValue(versionOk()))
    expect(engine.offlineState().level).toBe('unknown')
    await engine.checkVersion()
    expect(engine.offlineState().level).toBe('ok')
    vi.setSystemTime(new Date(T0 + 10 * H))
    expect(engine.offlineState().level).toBe('warn')
    vi.setSystemTime(new Date(T0 + 12 * H))
    expect(engine.offlineState()).toEqual({ level: 'locked', offlineMs: 12 * H })
  })

  it('a locked tablet can still enqueue: the engine never throws, the UI gates', async () => {
    const { engine } = make(vi.fn().mockResolvedValue(versionOk()))
    await engine.checkVersion()
    vi.setSystemTime(new Date(T0 + 13 * H))
    const item = await enqueueOffline(engine)
    expect(item.envelope).toMatchObject({ offlineMs: 13 * H })
  })

  it('the newest captured item keeps the window from shrinking after a clock set back', async () => {
    const { engine } = make(vi.fn().mockResolvedValue(versionOk()))
    await engine.checkVersion()
    vi.setSystemTime(new Date(T0 + 11 * H))
    await enqueueOffline(engine)
    vi.setSystemTime(new Date(T0 + 2 * H)) // clock set back
    expect(engine.offlineState().level).toBe('warn')
  })
})

describe('offline_expired goes to review (A05)', () => {
  it('a non-retryable offline_expired result parks the item for review, never drops it', async () => {
    const request = vi.fn().mockImplementation(async (_m: string, path: string, body?: { items: { idempotencyKey: string }[] }) => {
      if (!body) return versionOk()
      return {
        data: {
          processed: 0, version: 0,
          results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'lebih dari 12 jam', code: 'offline_expired', retryable: false })),
        },
      }
    })
    const { engine } = make(request)
    await enqueueOffline(engine)
    await engine.flush()
    expect(engine.outbox.all()).toHaveLength(1)
    expect(engine.outbox.all()[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: 'offline_expired' })
    expect(engine.reviewItems()).toHaveLength(1)
  })
})
