import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Outbox, SyncEngine, type KV } from '@mandalika/sync'
import { SyncStatus } from '../components/SyncStatus'
import { diagnosticExportMessages, shareFailedSyncDiagnostics } from './failedSyncDiagnostics'

function fixture() {
  const store = new Map<string, string>()
  const kv: KV = {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value) },
    remove: (key) => { store.delete(key) },
  }
  const request = vi.fn().mockRejectedValue(new Error('unexpected request'))
  const engine = new SyncEngine({ request }, {}, kv)
  for (const type of ['order', 'refund'] as const) {
    const key = `synthetic-device:${type}`
    engine.outbox.add(type, key, { items: [{ marker: `original-${type}` }], pin: 'SYNTHETIC-PIN' })
    for (let n = 0; n < 5; n++) engine.outbox.fail(key, 'synthetic gateway failure')
  }
  const renderStatus = (isOnline = true) => renderToStaticMarkup(createElement(SyncStatus, {
    isOnline, pendingCount: engine.pendingCount(), failed: engine.deadLettered(),
    wall: engine.getWall(), isResyncing: false,
    onResync: vi.fn(), onFlush: vi.fn(), onRetryFailed: vi.fn(), onExportLog: vi.fn(),
  }))
  return { engine, store, kv, request, renderStatus }
}

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('failed-sync diagnostic delivery and visible unresolved state', () => {
  it.each([
    ['share success', 'shared'],
    ['share cancellation', 'cancelled'],
    ['share failure', 'failed'],
    ['clipboard success', 'copied'],
    ['clipboard failure', 'failed'],
    ['no supported delivery', 'unavailable'],
  ] as const)('%s preserves the queue and visible count through repeated export', async (scenario, outcome) => {
    const { engine, store, kv, request, renderStatus } = fixture()
    const before = structuredClone(engine.outbox.all())
    const storedBefore = store.get('mandalika.pos.outbox')
    const markupBefore = renderStatus()
    expect(markupBefore).toContain('Sinkron gagal (2)')
    expect(renderStatus(false)).toContain('Offline · 2 gagal')
    const share = vi.fn().mockImplementation(async (data: ShareData) => {
      expect(data.text).toContain('original-order')
      expect(data.text).toContain('original-refund')
      expect(data.text).not.toContain('SYNTHETIC-PIN')
      if (scenario === 'share cancellation') throw new DOMException('cancelled', 'AbortError')
      if (scenario === 'share failure') throw new Error('blocked')
    })
    const writeText = vi.fn().mockImplementation(async (text: string) => {
      expect(text).toContain('original-order')
      expect(text).not.toContain('SYNTHETIC-PIN')
      if (scenario === 'clipboard failure') throw new Error('blocked')
    })
    const platform = scenario.startsWith('share') ? { share, clipboard: { writeText } }
      : scenario.startsWith('clipboard') ? { clipboard: { writeText } } : {}
    for (let i = 0; i < 2; i++) {
      const result = await shareFailedSyncDiagnostics(() => engine.buildFailedSyncDiagnostics(), platform)
      expect(result).toBe(outcome)
      expect(diagnosticExportMessages[result]).toContain('Transaksi gagal tetap')
      expect(engine.outbox.all()).toEqual(before)
      expect(store.get('mandalika.pos.outbox')).toBe(storedBefore)
      expect(new Outbox(kv).all()).toEqual(before)
      expect(renderStatus()).toBe(markupBefore)
      expect(renderStatus()).not.toContain('Semua tersinkron')
    }
    if (scenario.startsWith('share')) expect(writeText).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('reports diagnostic generation failure without invoking sharing or changing operations', async () => {
    const { engine, store } = fixture()
    const before = structuredClone(engine.outbox.all())
    const storedBefore = store.get('mandalika.pos.outbox')
    const share = vi.fn()
    const outcome = await shareFailedSyncDiagnostics(() => {
      engine.buildFailedSyncDiagnostics()
      throw new Error('synthetic formatter failure')
    }, { share })
    expect(outcome).toBe('failed')
    expect(share).not.toHaveBeenCalled()
    expect(engine.outbox.all()).toEqual(before)
    expect(store.get('mandalika.pos.outbox')).toBe(storedBefore)
  })
})
