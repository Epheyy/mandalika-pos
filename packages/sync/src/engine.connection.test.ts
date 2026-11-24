import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import type { ConnectionState } from './serverHold'
import { controllableKV } from './testFixtures/controllableKV'

// A29: "no internet" vs "server problem". The boolean reachable keeps its meaning (every non-answer and every
// 5xx is unreachable); the connection state only says why, for the indicator.

const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })
const http = (status: number, kind = 'http') => Object.assign(new Error(`http ${status}`), { status, kind })

beforeEach(() => { online(true) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function make(outcomes: unknown[], probeHost?: () => Promise<boolean>) {
  const queue = [...outcomes]
  const request = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    return next
  })
  const seen: ConnectionState[] = []
  const engine = new SyncEngine({ request } as unknown as ApiLike, { onConnection: (s) => seen.push(s) }, controllableKV().kv, { actor: null, probeHost })
  return { engine, request, seen }
}

const versionOk = { data: { version: 0 } }

describe('connection state from the version poll', () => {
  it('a 503 is a server problem and the boolean stays unreachable', async () => {
    const { engine } = make([http(503)])
    await engine.checkVersion()
    expect(engine.isReachable()).toBe(false)
    expect(engine.connectionState()).toBe('server_problem')
  })

  it.each([500, 502, 429, 408])('a %i is a server problem', async (status) => {
    const { engine } = make([http(status)])
    await engine.checkVersion()
    expect(engine.connectionState()).toBe('server_problem')
  })

  it('an HTML 502 (invalid_response) is a server problem', async () => {
    const { engine } = make([Object.assign(new Error('respons server tidak valid (502)'), { status: 502, kind: 'invalid_response' })])
    await engine.checkVersion()
    expect(engine.isReachable()).toBe(false)
    expect(engine.connectionState()).toBe('server_problem')
  })

  it('a 200 with a non-JSON body (invalid_response, status 200) is a server problem', async () => {
    const { engine } = make([Object.assign(new Error('respons server tidak valid (200)'), { status: 200, kind: 'invalid_response' })])
    await engine.checkVersion()
    expect(engine.connectionState()).toBe('server_problem')
  })

  it('a TypeError with a probe that answers is a server problem', async () => {
    const probe = vi.fn(async () => true)
    const { engine } = make([new TypeError('Failed to fetch')], probe)
    await engine.checkVersion()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(engine.isReachable()).toBe(false)
    expect(engine.connectionState()).toBe('server_problem')
  })

  it('a TypeError with a probe that fails is no internet', async () => {
    const { engine } = make([new TypeError('Failed to fetch')], async () => false)
    await engine.checkVersion()
    expect(engine.connectionState()).toBe('no_internet')
  })

  it('a probe that throws counts as no answer', async () => {
    const { engine } = make([new TypeError('Failed to fetch')], async () => { throw new Error('boom') })
    await engine.checkVersion()
    expect(engine.connectionState()).toBe('no_internet')
  })

  it('without a probe a TypeError is no internet', async () => {
    const { engine } = make([new TypeError('Failed to fetch')])
    await engine.checkVersion()
    expect(engine.connectionState()).toBe('no_internet')
  })

  it.each(['network', 'timeout'])('a %s failure is probed', async (kind) => {
    const probe = vi.fn(async () => true)
    const { engine } = make([Object.assign(new Error(kind), { status: 0, kind })], probe)
    await engine.checkVersion()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(engine.connectionState()).toBe('server_problem')
  })

  it('a server answer is never probed', async () => {
    const probe = vi.fn(async () => false)
    const { engine } = make([http(503)], probe)
    await engine.checkVersion()
    expect(probe).not.toHaveBeenCalled()
  })

  it('navigator.onLine false is no internet with no request', async () => {
    const { engine, request } = make([http(503)])
    await engine.checkVersion() // server_problem first
    online(false)
    await engine.checkVersion()
    expect(request).toHaveBeenCalledTimes(1)
    expect(engine.isReachable()).toBe(false)
    expect(engine.connectionState()).toBe('no_internet')
  })

  it('a 4xx means the server answered: reachable and online', async () => {
    const { engine } = make([http(403)])
    await engine.checkVersion()
    expect(engine.isReachable()).toBe(true)
    expect(engine.connectionState()).toBe('online')
  })

  it('a 2xx after a server problem is online again', async () => {
    const { engine, seen } = make([http(503), versionOk])
    await engine.checkVersion()
    expect(engine.connectionState()).toBe('server_problem')
    await engine.checkVersion()
    expect(engine.isReachable()).toBe(true)
    expect(engine.connectionState()).toBe('online')
    expect(seen).toEqual(['server_problem', 'online'])
  })

  it('a slow probe of an older poll does not overwrite a newer success', async () => {
    let release!: (v: boolean) => void
    const probe = () => new Promise<boolean>((r) => { release = r })
    const { engine } = make([new TypeError('Failed to fetch'), versionOk], probe)
    const first = engine.checkVersion()
    await Promise.resolve()
    await engine.checkVersion() // the newer poll succeeds
    release(true)
    await first
    expect(engine.isReachable()).toBe(true)
    expect(engine.connectionState()).toBe('online')
  })
})

describe('connection state beyond the poll', () => {
  it('starts online when the browser is online and no_internet when it is not', () => {
    expect(make([versionOk]).engine.connectionState()).toBe('online')
    online(false)
    expect(make([versionOk]).engine.connectionState()).toBe('no_internet')
  })

  it('an offline batch failure keeps a known server_problem cause', async () => {
    const { engine } = make([http(503)])
    await engine.checkVersion()
    online(true)
    await engine.pollInbound() // another unreachable signal while already unreachable
    expect(engine.connectionState()).toBe('server_problem')
  })

  it('a failure while reachable that is not yet classified reads as no_internet until the poll refines it', async () => {
    const { engine } = make([http(503)])
    await engine.pollInbound()
    expect(engine.isReachable()).toBe(false)
    expect(engine.connectionState()).toBe('no_internet')
    await engine.checkVersion()
    expect(engine.connectionState()).toBe('server_problem')
  })
})
