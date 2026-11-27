import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Outlet, SalesStaff } from '@mandalika/api'
import { READ_ONLY_NOTE, SalesStaffDialog } from './SalesStaffDialog'

const outlets = [{ id: 'o1', name: 'BSD' }, { id: 'o2', name: 'Makassar' }] as Outlet[]
const noop = () => {}
const entry = (over: Partial<SalesStaff> = {}): SalesStaff => ({
  id: 's1', name: 'Rina', active: true, outletIds: ['o1'], hiddenOutletCount: 1, canEditDetails: true,
  user: { id: 'u1', displayName: 'Rina U' }, updatedAt: '2026-11-27T00:00:00Z', ...over,
})
const html = (e: SalesStaff | null, error: string | null = null) =>
  renderToStaticMarkup(
    <SalesStaffDialog entry={e} outlets={outlets} linkable={[{ id: 'u2', displayName: 'Budi' }]} busy={false} error={error} onSave={noop} onRelease={noop} onClose={noop} />,
  )

describe('SalesStaffDialog', () => {
  it('a new person: editable fields, no release button, outlets as checkboxes', () => {
    const out = html(null)
    expect(out).toContain('Tambah Sales')
    expect(out).not.toContain('Lepas dari outlet saya')
    expect(out).not.toContain(READ_ONLY_NOTE)
    expect(out.match(/type="checkbox"/g)).toHaveLength(2)
    expect(out).toContain('— Tidak ditautkan —')
    expect(out).toContain('role="switch"')
  })
  it('keeps the current account selectable even though the linkable list lacks it', () => {
    const out = html(entry())
    expect(out).toContain('Rina U')
    expect(out).toContain('Budi')
  })
  it('canEditDetails=false disables Nama, akun and Aktif, shows the note and the release button', () => {
    const out = html(entry({ canEditDetails: false }))
    expect(out).toContain(READ_ONLY_NOTE)
    expect(out).toContain('Lepas dari outlet saya')
    expect(out).toMatch(/<input[^>]*id="sales-staff-name"[^>]*disabled=""|<input[^>]*disabled=""[^>]*id="sales-staff-name"/)
    expect(out).toMatch(/<select[^>]*disabled=""/)
    expect(out).toMatch(/<button[^>]*role="switch"[^>]*disabled=""|<button[^>]*disabled=""[^>]*role="switch"/)
  })
  it('canEditDetails=true leaves the fields enabled', () => {
    const out = html(entry())
    expect(out).not.toContain(READ_ONLY_NOTE)
    expect(out).not.toMatch(/<select[^>]*disabled=""/)
  })
  it('shows the server error', () => {
    expect(html(null, 'Nama sudah dipakai')).toContain('Nama sudah dipakai')
  })
})
