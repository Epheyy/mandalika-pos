import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError, createClient, DEFAULT_TIMEOUT_MS, EXPORT_TIMEOUT_MS, IMPORT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS, parseRetryAfter, probeHost, resolveTimeoutMs,
} from '@mandalika/api'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const api = (extra: Partial<Parameters<typeof createClient>[0]> = {}) =>
  createClient({ baseUrl: 'http://x', getToken: () => 'tok', ...extra })

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try { await p } catch (e) { return e as ApiError }
  throw new Error('expected the request to fail')
}

/** A fetch that never answers; it rejects when the caller aborts, like a browser. */
function hangingFetch() {
  vi.mocked(fetch).mockImplementation((_u, init) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
  }))
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('default deadline', () => {
  it('aborts a hung fetch at the 35 s default and says so for a GET', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const p = failure(api().request('GET', '/x'))
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const e = await p
    expect(e).toMatchObject({ kind: 'timeout', status: 0, message: 'Server tidak menjawab tepat waktu, coba lagi' })
  })

  it('aborts a hung body read at the default too', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((_u, init) => Promise.resolve({
      status: 200, ok: true, headers: new Headers(),
      text: () => new Promise<string>((_r, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
      }),
    } as unknown as Response))
    const p = failure(api().request('GET', '/x'))
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
    expect(await p).toMatchObject({ kind: 'timeout' })
  })

  it('a timed-out write does not claim the change failed', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const p = failure(api().request('POST', '/x', {}))
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
    const e = await p
    expect(e.kind).toBe('timeout')
    expect(e.message).toContain('Cek dulu apakah perubahan sudah tersimpan')
  })

  it('an explicit timeoutMs overrides the default', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const p = failure(api().request('GET', '/x', undefined, { timeoutMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toMatchObject({ kind: 'timeout' })
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined])('timeoutMs %s falls back to the route default', (t) => {
    expect(resolveTimeoutMs('GET', '/x', t)).toBe(DEFAULT_TIMEOUT_MS)
  })

  it('import routes get 240 s and movement export routes 90 s', () => {
    for (const path of ['/api/v1/products/import', '/api/v1/customers/import', '/api/v1/ingredients/import',
      '/api/v1/sku-mapping/import', '/api/v1/stock-counts/abc/import']) {
      expect(resolveTimeoutMs('POST', path)).toBe(IMPORT_TIMEOUT_MS)
    }
    expect(IMPORT_TIMEOUT_MS).toBe(240_000)
    expect(resolveTimeoutMs('GET', '/api/v1/inventory/movements/export?x=1')).toBe(EXPORT_TIMEOUT_MS)
    expect(resolveTimeoutMs('GET', '/api/v1/inventory/movements/summary/export')).toBe(EXPORT_TIMEOUT_MS)
    expect(EXPORT_TIMEOUT_MS).toBe(90_000)
  })

  it('an import call is still alive at 200 s', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const p = failure(api().request('POST', '/api/v1/products/import', {}))
    await vi.advanceTimersByTimeAsync(200_000)
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await p).toMatchObject({ kind: 'timeout' })
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-24T10:00:00Z')
  it('reads delta-seconds', () => expect(parseRetryAfter('7', now)).toBe(7000))
  it('reads an HTTP-date', () => expect(parseRetryAfter('Tue, 24 Nov 2026 10:01:00 GMT', now)).toBe(60_000))
  it('a past date is 0', () => expect(parseRetryAfter('Tue, 24 Nov 2026 09:00:00 GMT', now)).toBe(0))
  it('rejects garbage, negatives and empties', () => {
    for (const v of ['soon', '-3', '1.5', '', '   ', null]) expect(parseRetryAfter(v, now)).toBeUndefined()
  })
  it('clamps to 30 minutes', () => {
    expect(parseRetryAfter('999999', now)).toBe(MAX_RETRY_AFTER_MS)
    expect(parseRetryAfter('Wed, 24 Nov 2027 10:00:00 GMT', now)).toBe(MAX_RETRY_AFTER_MS)
  })
})

describe('retryAfterMs on an ApiError', () => {
  it.each([429, 503])('is read from the header on a %s', async (status) => {
    vi.mocked(fetch).mockResolvedValue(json(status, { error: 'busy' }, { 'Retry-After': '12' }))
    expect((await failure(api().request('GET', '/x'))).retryAfterMs).toBe(12_000)
  })

  it('falls back to the body retryAfterSeconds', async () => {
    vi.mocked(fetch).mockResolvedValue(json(429, { error: 'pin', retryAfterSeconds: 30 }))
    expect((await failure(api().request('GET', '/x'))).retryAfterMs).toBe(30_000)
  })

  it('is absent when neither is given', async () => {
    vi.mocked(fetch).mockResolvedValue(json(503, { error: 'busy' }))
    expect((await failure(api().request('GET', '/x'))).retryAfterMs).toBeUndefined()
  })

  it('is read from an HTML 503 page too', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>busy</html>', { status: 503, headers: { 'Retry-After': '9' } }))
    expect(await failure(api().request('GET', '/x'))).toMatchObject({ kind: 'invalid_response', retryAfterMs: 9000 })
  })

  it('is not set on a 500, even with the header', async () => {
    vi.mocked(fetch).mockResolvedValue(json(500, { error: 'boom' }, { 'Retry-After': '12' }))
    expect((await failure(api().request('GET', '/x'))).retryAfterMs).toBeUndefined()
  })

  it.each([429, 503])('a silent refresh answered %s carries it', async (status) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(status, { error: 'busy' }, { 'Retry-After': '20' }))
    const e = await failure(api({ getRefresh: () => 'rt' }).request('GET', '/x'))
    expect(e).toMatchObject({ status, retryAfterMs: 20_000 })
  })
})

describe('probeHost', () => {
  it('is true when the host answers, including an opaque answer', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }))
    expect(await probeHost('http://x')).toBe(true)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://x/healthz')
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ mode: 'no-cors', cache: 'no-store' })
  })

  it('is false when fetch rejects', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await probeHost('http://x')).toBe(false)
  })

  it('is false on timeout', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const p = probeHost('http://x', 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe(false)
  })
})
