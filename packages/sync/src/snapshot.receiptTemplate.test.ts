import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { SyncEngine, type ApiLike } from './engine'
import { Snapshot } from './snapshot'
import { controllableKV } from './testFixtures/controllableKV'

type Bundle = components['schemas']['SyncPullBundle']
type Template = components['schemas']['SyncReceiptTemplate']

const TEMPLATE: Template = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 3,
  paperWidth: 58,
  blocks: [
    { id: 'i', type: 'items', enabled: true },
    { id: 'o', type: 'totals', enabled: true },
    { id: 'p', type: 'payment', enabled: true },
  ],
}

describe('receiptTemplate in the persisted snapshot', () => {
  it('survives a reload from storage, with the outlet address and phone', () => {
    const { kv } = controllableKV()
    new Snapshot(kv).replace({ version: 3, receiptTemplate: TEMPLATE, outletAddress: 'Jl. Kuta 1', outletPhone: '0361 111' } as Bundle)
    const reloaded = new Snapshot(kv).get()
    expect(reloaded.receiptTemplate).toEqual(TEMPLATE)
    expect(reloaded.outletAddress).toBe('Jl. Kuta 1')
    expect(reloaded.outletPhone).toBe('0361 111')
  })

  it('is absent for a bundle from an older server or an outlet without a template', () => {
    const { kv } = controllableKV()
    new Snapshot(kv).replace({ version: 3 } as Bundle)
    expect(new Snapshot(kv).get().receiptTemplate).toBeUndefined()
  })
})

function makeServer() {
  const s: { template: Template | undefined; failPull: boolean } = { template: TEMPLATE, failPull: false }
  const request = vi.fn(async (method: string, path: string) => {
    if (method === 'GET' && path.includes('/sync/pull')) {
      if (s.failPull) throw new TypeError('network')
      return {
        data: {
          version: 1,
          products: [], categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [],
          ...(s.template ? { receiptTemplate: s.template } : {}),
        },
      }
    }
    if (method === 'GET' && path.includes('/sync/inbound')) return { data: [] }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return { s, api: { request: request as unknown as ApiLike['request'] } as ApiLike }
}

describe('a pull and the cached receipt template', () => {
  beforeEach(() => { vi.stubGlobal('navigator', { onLine: false }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('a failed pull leaves the template unchanged; a later pull without one clears it', async () => {
    const { s, api } = makeServer()
    const engine = new SyncEngine(api, {}, controllableKV().kv, { actor: null })
    await engine.resync()
    expect(engine.getSnapshot().receiptTemplate).toEqual(TEMPLATE)

    s.failPull = true
    await engine.resync().catch(() => undefined)
    expect(engine.getSnapshot().receiptTemplate).toEqual(TEMPLATE)

    s.failPull = false
    s.template = undefined
    await engine.resync()
    expect(engine.getSnapshot().receiptTemplate).toBeUndefined()
  })
})
