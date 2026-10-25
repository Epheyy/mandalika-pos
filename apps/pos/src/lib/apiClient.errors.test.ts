import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from '@mandalika/api'
import { SyncEngine } from '@mandalika/sync'
import { controllableKV } from '../../../../packages/sync/src/testFixtures/controllableKV'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function client(extra: Partial<Parameters<typeof createClient>[0]> = {}) {
  const onUnauthorized = vi.fn()
  const onTokens = vi.fn()
  const api = createClient({
    baseUrl: 'http://x',
    getToken: () => 'old',
    getRefresh: () => 'refresh-token',
    onUnauthorized,
    onTokens,
    ...extra,
  })
  return { api, onUnauthorized, onTokens }
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    return e as ApiError
  }
  throw new Error('expected the request to fail')
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('api client failures are typed', () => {
  it('a fetch TypeError is kind=network, status 0', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    const e = await failure(client().api.request('POST', '/api/v1/sync/batch', {}))
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ kind: 'network', status: 0 })
  })

  it('a hung request is aborted at timeoutMs and typed kind=timeout', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const p = failure(client().api.request('POST', '/x', {}, { timeoutMs: 30_000 }))
    await vi.advanceTimersByTimeAsync(29_999)
    vi.mocked(fetch).mock.calls.forEach(([, init]) => expect(init?.signal?.aborted).toBe(false))
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toMatchObject({ kind: 'timeout', status: 0 })
  })

  it('no timer or signal is used when timeoutMs is not given', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { data: 1 }))
    await client().api.request('GET', '/x')
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeUndefined()
  })

  it('an HTML 502 page is kind=invalid_response and keeps the status', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }))
    expect(await failure(client().api.request('GET', '/x'))).toMatchObject({ kind: 'invalid_response', status: 502 })
  })

  it('a 200 with a non-JSON body is kind=invalid_response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>captive portal</html>', { status: 200 }))
    expect(await failure(client().api.request('GET', '/x'))).toMatchObject({ kind: 'invalid_response', status: 200 })
  })

  it('a non-JSON 4xx stays a deterministic http error', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>forbidden</html>', { status: 403 }))
    expect(await failure(client().api.request('GET', '/x'))).toMatchObject({ kind: 'http', status: 403 })
  })

  it('a JSON error keeps the server message and kind=http', async () => {
    vi.mocked(fetch).mockResolvedValue(json(400, { error: 'invalid body' }))
    const e = await failure(client().api.request('GET', '/x'))
    expect(e).toMatchObject({ kind: 'http', status: 400, message: 'invalid body' })
  })
})

describe('401 goes through the refresh path', () => {
  it('refreshes once, stores the tokens and retries the request', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(200, { data: { access: 'new', refresh: 'r2' } }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }))
    const { api, onUnauthorized, onTokens } = client()
    expect(await api.request('POST', '/api/v1/sync/batch', {})).toEqual({ data: { ok: true } })
    expect(onTokens).toHaveBeenCalledWith({ access: 'new', refresh: 'r2' })
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('http://x/api/v1/auth/refresh')
  })

  it('a refresh that cannot reach the server is a network failure, not a logout', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { api, onUnauthorized } = client()
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ kind: 'network', status: 0 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a refresh answered 5xx is not a verdict on the session either', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(503, { error: 'down' }))
    const { api, onUnauthorized } = client()
    // typed with the real status so callers treat it as transient (backoff), not offline
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ kind: 'http', status: 503 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a refresh answered 429 is typed http 429', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(429, { error: 'slow down' }))
    const { api, onUnauthorized } = client()
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ kind: 'http', status: 429 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a hung refresh is aborted after its own timeout: typed timeout, no logout, next request can run', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        })
      }
      return Promise.resolve(json(401, {}))
    })
    const { api, onUnauthorized } = client()
    const p = failure(api.request('POST', '/x', {}))
    await vi.advanceTimersByTimeAsync(14_999)
    const refreshCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/auth/refresh'))!
    expect(refreshCall[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toMatchObject({ kind: 'timeout', status: 0 })
    expect(onUnauthorized).not.toHaveBeenCalled()
    // the de-dupe slot was released, so a later request refreshes again and succeeds
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { data: { access: 'new', refresh: 'r2' } }))
      .mockResolvedValueOnce(json(200, { data: 1 }))
    expect(await api.request('POST', '/x', {})).toEqual({ data: 1 })
  })

  it('a refresh the server refuses ends the session with a typed 401', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(401, { error: 'bad refresh' }))
    const { api, onUnauthorized } = client()
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ status: 401, kind: 'http' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  // A05: only a 401 from the refresh endpoint ends the session. Any other refusal
  // (proxy 400/403/404/407, a 200 without tokens) is an outage, not a revoked credential.
  it.each([400, 403, 404, 407, 413, 422])('a refresh answered %i is no verdict: transient, session kept', async (status) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(status, { error: 'proxy' }))
    const { api, onUnauthorized } = client()
    // Never the refresh endpoint's own status: callers would read 400/413/422 as "this body is bad".
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ kind: 'invalid_response', status: 0 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  // End to end through the engine: the refresh endpoint's status must never be held against the queue.
  it.each([400, 403, 404, 407, 413, 422])('a /sync/batch whose refresh answers %i keeps every item pending', async (status) => {
    vi.stubGlobal('navigator', { onLine: true })
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).endsWith('/auth/refresh') ? json(status, { error: 'proxy' }) : json(401, { error: 'expired' }))
    const { api, onUnauthorized } = client()
    const kv = controllableKV().kv
    const engine = new SyncEngine(api, {}, kv, { actor: null })
    vi.stubGlobal('navigator', { onLine: false })
    await engine.enqueue('order', { total: 1 })
    await engine.enqueue('order', { total: 2 })
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flush()
    expect(engine.outbox.all()).toHaveLength(2)
    expect(engine.reviewItems()).toHaveLength(0)
    expect(engine.outbox.all().every((i) => i.status !== 'failed' || (i.attempts ?? 0) === 0)).toBe(true)
    expect(onUnauthorized).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('a refresh answered 200 without an access token keeps the session (invalid_response)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(200, { data: {} }))
    const { api, onUnauthorized, onTokens } = client()
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ kind: 'invalid_response', status: 0 })
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(onTokens).not.toHaveBeenCalled()
  })
})

describe('requestCsv (exportStockCount / exportStockMovements)', () => {
  const csv = (status: number, body: string, type = 'text/csv; charset=utf-8') =>
    new Response(body, { status, headers: { 'Content-Type': type } })

  it('returns the CSV body verbatim and asks for text/csv', async () => {
    vi.mocked(fetch).mockResolvedValue(csv(200, 'a,b\n1,2\n'))
    expect(await client().api.exportStockCount('c1')).toBe('a,b\n1,2\n')
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Accept: 'text/csv', Authorization: 'Bearer old' })
  })

  it('a fetch TypeError is kind=network, status 0', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await failure(client().api.exportStockCount('c1'))).toMatchObject({ kind: 'network', status: 0 })
  })

  it('a failure while reading the body is kind=network, status 0', async () => {
    const res = csv(200, 'x')
    vi.spyOn(res, 'text').mockRejectedValue(new TypeError('body stream broke'))
    vi.mocked(fetch).mockResolvedValue(res)
    expect(await failure(client().api.exportStockCount('c1'))).toMatchObject({ kind: 'network', status: 0 })
  })

  it('401 refreshes once and retries with the new token', async () => {
    let token = 'old'
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(200, { data: { access: 'new', refresh: 'r2' } }))
      .mockResolvedValueOnce(csv(200, 'ok\n'))
    const { api } = client({ getToken: () => token, onTokens: (t: { access: string }) => { token = t.access } })
    expect(await api.exportStockCount('c1')).toBe('ok\n')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(fetch).mock.calls[2][1]?.headers).toMatchObject({ Authorization: 'Bearer new' })
  })

  it('a 200 that is not CSV is kind=invalid_response', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { data: 'oops' }))
    expect(await failure(client().api.exportStockCount('c1'))).toMatchObject({ kind: 'invalid_response', status: 200 })
  })

  it('application/octet-stream is accepted as CSV', async () => {
    vi.mocked(fetch).mockResolvedValue(csv(200, 'a\n', 'application/octet-stream'))
    expect(await client().api.exportStockCount('c1')).toBe('a\n')
  })

  it('a non-JSON 502 is kind=invalid_response and a JSON 403 keeps its message and body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }))
    expect(await failure(client().api.exportStockCount('c1'))).toMatchObject({ kind: 'invalid_response', status: 502 })
    vi.mocked(fetch).mockResolvedValueOnce(json(403, { error: 'dilarang' }))
    expect(await failure(client().api.exportStockCount('c1'))).toMatchObject({ kind: 'http', status: 403, message: 'dilarang', body: { error: 'dilarang' } })
  })
})

describe('qsMulti query encoding', () => {
  const url = async (params: Parameters<ReturnType<typeof client>['api']['listStockMovements']>[0]) => {
    vi.mocked(fetch).mockResolvedValue(json(200, { data: [] }))
    await client().api.listStockMovements(params)
    return String(vi.mocked(fetch).mock.calls[0][0])
  }

  it('repeats array keys, keeps giveaway=false and drops undefined, null and empty strings', async () => {
    const u = await url({
      locationType: 'outlet',
      locationId: 'L1',
      kind: ['sale', 'refund'],
      giveaway: false,
      productId: undefined,
      variantSize: '',
      flag: null,
    } as never)
    expect(u).toBe('http://x/api/v1/inventory/movements?locationType=outlet&locationId=L1&kind=sale&kind=refund&giveaway=false')
  })
})

describe('requisition outlet methods take request options (S6-0)', () => {
  it('a hung create is aborted at timeoutMs as kind=timeout and the Idempotency-Key header is kept', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation((_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const p = failure(client().api.createRequisition({ items: [] } as never, 'key-1', { timeoutMs: 20_000 }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await p).toMatchObject({ kind: 'timeout', status: 0 })
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('key-1')
  })

  it('the required key wins over a caller-supplied Idempotency-Key header', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { data: { id: 'r1' } }))
    await client().api.submitRequisition('r1', 'real-key', { headers: { 'Idempotency-Key': 'other', 'X-Extra': '1' } })
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('real-key')
    expect(headers['X-Extra']).toBe('1')
  })

  it('list and get honour timeoutMs; without opts no signal is used', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { data: [] }))
    await client().api.listRequisitions({}, { timeoutMs: 5_000 })
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeDefined()
    vi.mocked(fetch).mockResolvedValue(json(200, { data: { id: 'r1' } }))
    await client().api.getRequisition('r1')
    expect(vi.mocked(fetch).mock.calls[1][1]?.signal).toBeUndefined()
  })
})
