import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from '@mandalika/api'

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
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ kind: 'network' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a refresh the server refuses ends the session with a typed 401', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'expired' }))
      .mockResolvedValueOnce(json(401, { error: 'bad refresh' }))
    const { api, onUnauthorized } = client()
    expect(await failure(api.request('POST', '/x', {}))).toMatchObject({ status: 401, kind: 'http' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})
