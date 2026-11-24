import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Outlet } from '@mandalika/api'
import { OutletCoverageField } from './OutletCoverageField'

const outlets = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] as Outlet[]
const render = (role: 'admin' | 'manager' | 'cashier', value: Parameters<typeof OutletCoverageField>[0]['value']) =>
  renderToStaticMarkup(<OutletCoverageField role={role} value={value} onChange={() => {}} outlets={outlets} />)

describe('OutletCoverageField', () => {
  it('is hidden for an admin', () => {
    expect(render('admin', { mode: 'all', homeId: '', outletIds: [] })).toBe('')
  })
  it('cashier gets one required select without Semua Outlet', () => {
    const html = render('cashier', { mode: 'specific', homeId: '', outletIds: [] })
    expect(html).toContain('Pilih outlet')
    expect(html).not.toContain('Semua Outlet')
    expect(html).toContain('Pilih satu outlet untuk kasir.')
  })
  it('manager specific shows the checklist and Outlet utama limited to ticked outlets', () => {
    const html = render('manager', { mode: 'specific', homeId: 'b', outletIds: ['b'] })
    expect(html).toContain('Outlet tertentu')
    expect(html).toContain('Outlet utama')
    expect(html.match(/<option/g)).toHaveLength(1)
  })
  it('manager with no choice shows the error; All hides the checklist', () => {
    expect(render('manager', { mode: 'none', homeId: '', outletIds: [] })).toContain('Pilih Semua Outlet atau minimal satu outlet.')
    expect(render('manager', { mode: 'all', homeId: '', outletIds: [] })).not.toContain('Outlet utama')
  })
})
