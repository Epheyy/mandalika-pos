import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionPicker, permissionsForRole } from './PermissionPicker'

describe('PermissionPicker', () => {
  it('no longer offers manage_users (Pengguna is admin-only), but still offers other permissions', () => {
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<PermissionPicker selected={[]} onToggle={() => {}} compact={compact} />)
      expect(html).not.toContain('Kelola Pengguna')
      expect(html).toContain('Kelola Outlet')
    }
  })

  it('PermissionPicker lists Batalkan Transaksi and Batalkan Transaksi Shift Sendiri', () => {
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<PermissionPicker selected={[]} onToggle={() => {}} compact={compact} />)
      expect(html).toContain('Batalkan Transaksi Shift Sendiri')
      expect(html).toContain('Batalkan Transaksi<')
    }
  })

  it('cashier role pre-selects void_own_shift', () => {
    expect(permissionsForRole('cashier', [])).toEqual(['void_own_shift'])
    expect(permissionsForRole('cashier', ['view_reports'])).toEqual(['view_reports'])
    expect(permissionsForRole('admin', [])).toEqual([])
  })

  it('manager role pre-selects manage_sales_staff only on an empty selection', () => {
    expect(permissionsForRole('manager', [])).toEqual(['manage_sales_staff'])
    expect(permissionsForRole('manager', ['view_reports'])).toEqual(['view_reports'])
    expect(permissionsForRole('cashier', ['manage_sales_staff'], 'manager')).toEqual([])
    expect(permissionsForRole('cashier', ['manage_sales_staff', 'view_reports'], 'manager')).toEqual(['manage_sales_staff', 'view_reports'])
  })

  it('offers Kelola Sales', () => {
    for (const compact of [false, true]) {
      expect(renderToStaticMarkup(<PermissionPicker selected={[]} onToggle={() => {}} compact={compact} />)).toContain('Kelola Sales')
    }
  })

  it('leaving cashier drops only the auto-ticked void_own_shift', () => {
    expect(permissionsForRole('manager', ['void_own_shift'], 'cashier')).toEqual([])
    expect(permissionsForRole('manager', ['void_own_shift', 'view_reports'], 'cashier')).toEqual(['void_own_shift', 'view_reports'])
    expect(permissionsForRole('manager', ['view_reports'], 'cashier')).toEqual(['view_reports'])
    expect(permissionsForRole('admin', ['void_own_shift'], 'manager')).toEqual(['void_own_shift'])
  })
})
