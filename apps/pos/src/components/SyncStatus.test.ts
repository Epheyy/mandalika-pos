import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReviewRow, SyncStatus } from './SyncStatus'

const item = (k: string) => ({ idempotencyKey: k, type: 'order', lastError: 'x' })
const render = (over: Partial<Parameters<typeof SyncStatus>[0]>) => renderToStaticMarkup(createElement(SyncStatus, {
  isOnline: true, pendingCount: 0, review: [], stuck: [],
  wall: { raised: false, localVersion: 1, serverVersion: 1 }, isResyncing: false,
  onResync: vi.fn(), onFlush: vi.fn(), onRetryFailed: vi.fn(), onExportLog: vi.fn(),
  ...over,
}))

describe('SyncStatus chip', () => {
  const raised = { raised: true, localVersion: 1, serverVersion: 2 }

  it('shows "Memperbarui data…" while a pull is in flight', () => {
    expect(render({ wall: raised, isResyncing: true })).toContain('Memperbarui data…')
  })

  it('shows "Data baru siap · perbarui" while the wall is raised and idle', () => {
    expect(render({ wall: raised })).toContain('Data baru siap · perbarui')
  })

  it('updating ranks below review, account, stuck and pending', () => {
    expect(render({ wall: raised, isResyncing: true, review: [item('a')] })).toContain('1 perlu ditinjau')
    expect(render({ wall: raised, isResyncing: true, accountProblem: 'x' })).toContain('Masalah akun')
    expect(render({ wall: raised, isResyncing: true, stuck: [item('a')], pendingCount: 1 })).toContain('1 tertunda')
    expect(render({ wall: raised, isResyncing: true, pendingCount: 2 })).toContain('Mengirim 2…')
    expect(render({ wall: raised, isResyncing: true, review: [item('a')] })).not.toContain('Memperbarui data')
  })

  it('a manual-only sync with no raised wall does not claim new data', () => {
    expect(render({ isResyncing: true })).not.toContain('Data baru siap')
  })
  it('shows "N perlu ditinjau" for parked items', () => {
    expect(render({ review: [item('a'), item('b')] })).toContain('2 perlu ditinjau')
  })

  it('keeps stuck-retrying items visible on their own label', () => {
    expect(render({ stuck: [item('a')], pendingCount: 1 })).toContain('1 tertunda')
  })

  it('review wins over stuck when both exist', () => {
    const html = render({ review: [item('a')], stuck: [item('b')] })
    expect(html).toContain('1 perlu ditinjau')
  })

  it('offline is the plain offline state: no "server" wording, stuck items not announced', () => {
    const html = render({ isOnline: false, stuck: [item('a')], pendingCount: 1 })
    expect(html).toContain('Offline · 1 tersimpan')
    expect(html).not.toContain('tertunda')
    expect(html).not.toMatch(/server/i)
  })

  it('shows the account problem state when online', () => {
    const html = render({ accountProblem: 'Masalah akun/outlet — hubungi admin.', pendingCount: 2 })
    expect(html).toContain('Masalah akun')
    expect(html).not.toContain('perlu ditinjau')
  })

  it('offline never shows the account problem state', () => {
    expect(render({ isOnline: false, accountProblem: 'x', pendingCount: 1 })).not.toContain('Masalah akun')
  })

  it('offline with review items still counts them', () => {
    expect(render({ isOnline: false, review: [item('a')] })).toContain('Offline · 1 perlu ditinjau')
  })
})

describe('Koneksi & antrean sheet', () => {
  const open = (over: Partial<Parameters<typeof SyncStatus>[0]>) => render({ open: true, ...over })
  it('is closed until opened and titled "Koneksi & antrean"', () => {
    expect(render({})).not.toContain('Koneksi')
    expect(open({})).toContain('Koneksi &amp; antrean')
  })
  it('offers Kirim sekarang (N) for queued items', () => {
    const html = open({ pendingCount: 3 })
    expect(html).toContain('Kirim sekarang (3)')
    expect(html).toContain('Tersimpan di tablet (3)')
  })
  it('offers Perbarui data when the wall is raised', () => {
    expect(open({ wall: { raised: true, localVersion: 1, serverVersion: 2 } })).toContain('Perbarui data')
  })
  it('review rows carry the plain sentence and hide the raw error behind Detail teknis', () => {
    const html = open({ review: [{ ...item('a'), lastError: 'boom 500' }] })
    expect(html).toContain('Perlu ditinjau (1)')
    expect(html).toContain('Transaksi aman di tablet ini.')
    expect(html).toContain('Bagikan log')
    expect(html.indexOf('Detail teknis')).toBeLessThan(html.indexOf('boom 500'))
  })
  it('C2: per-row Coba lagi / Tandai sudah ditangani only when wired, plus the count line', () => {
    expect(open({ review: [item('a')] })).not.toContain('Tandai sudah ditangani')
    const html = open({ review: [item('a'), item('b')], pendingCount: 2, onRetryOne: vi.fn(), onAcknowledge: vi.fn() })
    expect(html.match(/Tandai sudah ditangani/g)).toHaveLength(2)
    expect(html.match(/aria-label="Coba lagi: Penjualan/g)).toHaveLength(2)
    expect(html).toContain('2 transaksi tersimpan di tablet, 2 perlu ditinjau')
    expect(html).toContain('data-key="a"')
  })
  it('C2: an acknowledged row is hidden but still counted; the chip, Coba lagi and Bagikan log stay', () => {
    const html = open({ review: [item('a'), item('b')], acknowledged: new Set(['a']), onRetryOne: vi.fn(), onAcknowledge: vi.fn() })
    expect(html).not.toContain('data-key="a"')
    expect(html).toContain('data-key="b"')
    expect(html).toContain('Perlu ditinjau (2)')
    expect(html).toContain('1 transaksi sudah ditandai ditangani; tetap tersimpan di tablet.')
    const all = open({ review: [item('a')], acknowledged: new Set(['a']) })
    expect(all).toContain('1 perlu ditinjau')
    expect(all).toContain('Bagikan log')
    expect(all).toContain('>Coba lagi<')
  })
  it('puts the data versions under Detail teknis', () => {
    expect(open({})).toContain('Versi data lokal 1 · server 1')
  })
  it('explains offline and the hours left', () => {
    const html = open({ isOnline: false, offlineCap: { level: 'ok', offlineMs: 2 * 3_600_000 } })
    expect(html).toContain('terkirim otomatis saat online')
    expect(html).toContain('Sisa sekitar 10 jam')
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
    expect(html).toContain('Offline 10 jam · aman')
  })
  it('shows a locked chip at the cap', () => {
    const html = render({ isOnline: false, offlineCap: { level: 'locked', offlineMs: 12.2 * 3_600_000 } })
    expect(html).toContain('Offline terkunci · hubungi admin')
  })
  it('is unchanged while ok or unknown', () => {
    expect(render({ isOnline: false, offlineCap: { level: 'ok', offlineMs: 3_600_000 } })).toContain('Offline · aman')
    expect(render({ isOnline: false, offlineCap: { level: 'unknown', offlineMs: null } })).toContain('Offline · aman')
  })
  it('puts the 10 h nudge in the sheet only', () => {
    const html = render({ open: true, isOnline: false, offlineCap: { level: 'warn', offlineMs: 10.2 * 3_600_000 } })
    expect(html).toContain('Offline hampir 12 jam. Sambungkan internet agar penjualan tidak terkunci.')
  })
})

describe('SyncStatus automatic-update note', () => {
  it('is shown by default only while the wall is raised and auto-pull is available (source pin: the panel is client-side state)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./SyncStatus.tsx', import.meta.url), 'utf8')
    expect(src).toContain('o.autoUpdate ?')
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


describe('SyncStatus OTA prompt (C5)', () => {
  const ota = { version: '2.3.1', blockedBy: null, applying: false, error: null, onRestart: vi.fn() }
  it('shows nothing when no update is waiting', () => {
    expect(render({ open: true })).not.toContain('Versi baru siap')
  })
  it('shows the prompt with an enabled restart button when the cashier is idle', () => {
    const html = render({ open: true, otaUpdate: ota })
    expect(html).toContain('Versi baru siap (2.3.1)')
    expect(html).toContain('Mulai ulang sekarang')
    expect(html).not.toContain('ota-block-reason')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Mulai ulang sekarang/)
  })
  it('disables the button and gives the reason while a sale is open', () => {
    const html = render({ open: true, otaUpdate: { ...ota, blockedBy: 'cart' } })
    expect(html).toContain('Keranjang belum kosong.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Mulai ulang sekarang/)
  })
  it('shows progress and failure copy', () => {
    expect(render({ open: true, otaUpdate: { ...ota, applying: true } })).toContain('Memulai ulang…')
    expect(render({ open: true, otaUpdate: { ...ota, error: 'Gagal memulai ulang. Coba lagi.' } })).toContain('Gagal memulai ulang. Coba lagi.')
  })
})
