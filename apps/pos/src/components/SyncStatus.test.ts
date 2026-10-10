import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SyncStatus } from './SyncStatus'

const item = (k: string) => ({ idempotencyKey: k, type: 'order', lastError: 'x' })
const render = (over: Partial<Parameters<typeof SyncStatus>[0]>) => renderToStaticMarkup(createElement(SyncStatus, {
  isOnline: true, pendingCount: 0, review: [], stuck: [],
  wall: { raised: false, localVersion: 1, serverVersion: 1 }, isResyncing: false,
  onResync: vi.fn(), onFlush: vi.fn(), onRetryFailed: vi.fn(), onExportLog: vi.fn(),
  ...over,
}))

describe('SyncStatus chip', () => {
  it('shows "Perlu ditinjau (n)" for parked items', () => {
    expect(render({ review: [item('a'), item('b')] })).toContain('Perlu ditinjau (2)')
  })

  it('keeps stuck-retrying items visible on their own label', () => {
    expect(render({ stuck: [item('a')], pendingCount: 1 })).toContain('Tertunda (1)')
  })

  it('review wins over stuck when both exist', () => {
    const html = render({ review: [item('a')], stuck: [item('b')] })
    expect(html).toContain('Perlu ditinjau (1)')
  })

  it('offline is the plain offline state: no "server" wording, stuck items not announced', () => {
    const html = render({ isOnline: false, stuck: [item('a')], pendingCount: 1 })
    expect(html).toContain('Offline')
    expect(html).not.toContain('Tertunda')
    expect(html).not.toMatch(/server/i)
  })

  it('offline with review items still counts them', () => {
    expect(render({ isOnline: false, review: [item('a')] })).toContain('Offline · 1 perlu ditinjau')
  })
})
