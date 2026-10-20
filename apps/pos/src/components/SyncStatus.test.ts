import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OfflineCapNotice, ReviewRow, SyncStatus } from './SyncStatus'

const item = (k: string) => ({ idempotencyKey: k, type: 'order', lastError: 'x' })
const render = (over: Partial<Parameters<typeof SyncStatus>[0]>) => renderToStaticMarkup(createElement(SyncStatus, {
  isOnline: true, pendingCount: 0, review: [], stuck: [],
  wall: { raised: false, localVersion: 1, serverVersion: 1 }, isResyncing: false,
  onResync: vi.fn(), onFlush: vi.fn(), onRetryFailed: vi.fn(), onExportLog: vi.fn(),
  ...over,
}))

describe('SyncStatus chip', () => {
  const raised = { raised: true, localVersion: 1, serverVersion: 2 }

  it('shows "Memperbarui..." while a pull is in flight and the wall is raised', () => {
    expect(render({ wall: raised, isResyncing: true })).toContain('Memperbarui...')
  })

  it('keeps "Pembaruan tersedia" as the status while the wall is raised and idle', () => {
    expect(render({ wall: raised })).toContain('Pembaruan tersedia')
  })

  it('"Memperbarui..." ranks below review, account, stuck and pending', () => {
    expect(render({ wall: raised, isResyncing: true, review: [item('a')] })).toContain('Perlu ditinjau (1)')
    expect(render({ wall: raised, isResyncing: true, accountProblem: 'x' })).toContain('Masalah akun/outlet')
    expect(render({ wall: raised, isResyncing: true, stuck: [item('a')], pendingCount: 1 })).toContain('Tertunda (1)')
    expect(render({ wall: raised, isResyncing: true, pendingCount: 2 })).toContain('Menyinkronkan 2')
    expect(render({ wall: raised, isResyncing: true, review: [item('a')] })).not.toContain('Memperbarui...')
  })

  it('a manual-only sync with no raised wall does not claim an update', () => {
    expect(render({ isResyncing: true })).not.toContain('Pembaruan tersedia')
  })
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

  it('shows the account/outlet problem state when online', () => {
    const html = render({ accountProblem: 'Masalah akun/outlet — hubungi admin.', pendingCount: 2 })
    expect(html).toContain('Masalah akun/outlet')
    expect(html).not.toContain('Perlu ditinjau')
  })

  it('offline never shows the account problem state', () => {
    expect(render({ isOnline: false, accountProblem: 'x', pendingCount: 1 })).not.toContain('Masalah akun')
  })

  it('offline with review items still counts them', () => {
    expect(render({ isOnline: false, review: [item('a')] })).toContain('Offline · 1 perlu ditinjau')
  })
})

describe('review row detail (A06)', () => {
  const row = (f: Parameters<typeof ReviewRow>[0]['f']) => renderToStaticMarkup(createElement(ReviewRow, { f }))
  it('shows what a refund captured, above the reason', () => {
    const html = row({ idempotencyKey: 'k', type: 'refund', lastError: 'sudah direfund', detail: 'BSD-G0007 · Rp 225.000 · Tunai' })
    expect(html).toContain('BSD-G0007 · Rp 225.000 · Tunai')
    expect(html.indexOf('BSD-G0007')).toBeLessThan(html.indexOf('sudah direfund'))
  })
  it('renders an item without a snapshot exactly as before (no detail line)', () => {
    const html = row({ idempotencyKey: 'k', type: 'refund', lastError: 'ditolak' })
    expect(html).toContain('ditolak')
    expect(html).not.toContain('text-[11px]')
  })
})

describe('review row reported label', () => {
  it('shows "Dilaporkan ke kantor pusat" only once reported', () => {
    const base = { idempotencyKey: 'd:1', type: 'refund', lastError: 'denied' }
    expect(renderToStaticMarkup(createElement(ReviewRow, { f: { ...base, reported: true } }))).toContain('Dilaporkan ke kantor pusat')
    expect(renderToStaticMarkup(createElement(ReviewRow, { f: base }))).not.toContain('Dilaporkan')
  })
})

describe('SyncStatus offline cap (A05)', () => {
  it('shows the offline hours on the chip once the tablet nears the cap', () => {
    const html = render({ isOnline: false, offlineCap: { level: 'warn', offlineMs: 10.5 * 3_600_000 } })
    expect(html).toContain('Offline 10 jam')
  })
  it('shows a locked chip at the cap', () => {
    const html = render({ isOnline: false, offlineCap: { level: 'locked', offlineMs: 12.2 * 3_600_000 } })
    expect(html).toContain('Offline · terkunci')
  })
  it('is unchanged while ok or unknown', () => {
    expect(render({ isOnline: false, offlineCap: { level: 'ok', offlineMs: 3_600_000 } })).toContain('>Offline<')
    expect(render({ isOnline: false, offlineCap: { level: 'unknown', offlineMs: null } })).toContain('>Offline<')
  })
  it('renders the warning text in the notice', () => {
    const html = renderToStaticMarkup(createElement(OfflineCapNotice, { cap: { level: 'warn', offlineMs: 10.2 * 3_600_000 } }))
    expect(html).toContain('Sambungkan internet sebelum 12 jam')
    expect(renderToStaticMarkup(createElement(OfflineCapNotice, { cap: { level: 'locked', offlineMs: 13 * 3_600_000 } }))).toContain('dikunci')
    expect(renderToStaticMarkup(createElement(OfflineCapNotice, { cap: { level: 'ok', offlineMs: 1 } }))).toBe('')
  })
})

describe('SyncStatus automatic-update note', () => {
  it('is shown by default only while the wall is raised and auto-pull is available (source pin: the panel is client-side state)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./SyncStatus.tsx', import.meta.url), 'utf8')
    expect(src).toContain('updateAvailable && autoUpdate &&')
    expect(src).toContain('autoUpdate = true')
  })
})

describe('SyncStatus panel note', () => {
  it('explains the automatic update when the wall is raised (panel open state is client-side, so check the source)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./SyncStatus.tsx', import.meta.url), 'utf8')
    expect(src).toContain('Diperbarui otomatis saat keranjang kosong.')
    expect(src).not.toContain('the cashier decides when to sync')
  })
})

