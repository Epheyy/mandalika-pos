import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

// Auto-pull T1: resync() is single-flight, can be gated by the caller and says what happened.

interface Plan { gate?: Promise<void>; version?: number; fail?: Error }

function makeServer() {
  const s = { version: 1, plans: [] as Plan[], pulls: 0 }
  const request = vi.fn(async (method: string, path: string) => {
    if (method === 'GET' && path.includes('/sync/pull')) {
      s.pulls += 1
      const plan = s.plans.shift() ?? {}
      if (plan.gate) await plan.gate
      if (plan.fail) throw plan.fail
      return {
        data: {
          version: plan.version ?? s.version,
          products: [{ id: 'p1', name: 'A', isActive: true, variants: [{ size: '10ml', price: 1, stock: 5, sku: '' }] }],
          categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [],
        },
      }
    }
    if (method === 'GET' && path.includes('/sync/inbound')) return { data: [] }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return { s, api: { request: request as unknown as ApiLike['request'] } as ApiLike }
}

function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => { open = r })
  return { p, open }
}

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const make = () => {
  const { s, api } = makeServer()
  const engine = new SyncEngine(api, {}, controllableKV().kv, { actor: null })
  return { s, engine }
}

describe('resync single-flight and status', () => {
  it('returns applied for a normal pull', async () => {
    const { engine } = make()
    await expect(engine.resync()).resolves.toBe('applied')
    expect(engine.referenceVersion()).toBe(1)
  })

  it('concurrent callers share one request', async () => {
    const { s, engine } = make()
    const g = gate()
    s.plans.push({ gate: g.p })
    const a = engine.resync()
    const b = engine.resync()
    await Promise.resolve()
    g.open()
    await expect(Promise.all([a, b])).resolves.toEqual(['applied', 'applied'])
    expect(s.pulls).toBe(1)
  })

  it('shouldApply false after the response discards it and returns deferred', async () => {
    const { s, engine } = make()
    await engine.resync() // version 1 applied
    s.version = 2
    const before = engine.getSnapshot()
    await expect(engine.resync({ shouldApply: () => false })).resolves.toBe('deferred')
    expect(engine.referenceVersion()).toBe(1)
    expect(engine.getSnapshot()).toBe(before)
  })

  it('checks the gate again after the response, not only before the request', async () => {
    const { s, engine } = make()
    await engine.resync()
    s.version = 2
    let open = true
    const g = gate()
    s.plans.push({ gate: g.p })
    const p = engine.resync({ shouldApply: () => open })
    await Promise.resolve()
    open = false // the cashier added an item while the pull was in flight
    g.open()
    await expect(p).resolves.toBe('deferred')
    expect(engine.referenceVersion()).toBe(1)
  })

  it('a manual call joining a gated pull that defers runs a fresh ungated pull', async () => {
    const { s, engine } = make()
    await engine.resync()
    s.version = 2
    const g = gate()
    s.plans.push({ gate: g.p })
    const auto = engine.resync({ shouldApply: () => false })
    const manual = engine.resync()
    await Promise.resolve()
    g.open()
    await expect(auto).resolves.toBe('deferred')
    await expect(manual).resolves.toBe('applied')
    expect(engine.referenceVersion()).toBe(2)
    expect(s.pulls).toBe(3) // boot + gated + fresh
  })

  it('a gated caller joining a flight shares its result', async () => {
    const { s, engine } = make()
    const g = gate()
    s.plans.push({ gate: g.p })
    const a = engine.resync()
    const b = engine.resync({ shouldApply: () => false })
    await Promise.resolve()
    g.open()
    await expect(Promise.all([a, b])).resolves.toEqual(['applied', 'applied'])
    expect(s.pulls).toBe(1)
  })

  it('clears the flight after a failure so the next call pulls again', async () => {
    const { s, engine } = make()
    s.plans.push({ fail: Object.assign(new Error('boom'), { status: 500 }) })
    await expect(engine.resync()).rejects.toThrow('boom')
    expect(engine.isPulling()).toBe(false)
    await expect(engine.resync()).resolves.toBe('applied')
  })

  it('isPulling is true only while a pull is in flight', async () => {
    const { s, engine } = make()
    const g = gate()
    s.plans.push({ gate: g.p })
    expect(engine.isPulling()).toBe(false)
    const p = engine.resync()
    expect(engine.isPulling()).toBe(true)
    g.open()
    await p
    expect(engine.isPulling()).toBe(false)
  })

  it('a pull retired by dispose mid-flight returns stale and changes nothing', async () => {
    const { s, engine } = make()
    const g = gate()
    s.plans.push({ gate: g.p })
    const p = engine.resync()
    engine.dispose()
    g.open()
    await expect(p).resolves.toBe('stale')
    expect(engine.referenceVersion()).toBe(0)
  })
})
