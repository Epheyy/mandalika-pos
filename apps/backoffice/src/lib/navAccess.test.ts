import { describe, expect, it } from 'vitest'
import { canEditOutlet, canSeeNav } from './navAccess'

describe('canSeeNav', () => {
  it('canSeeNav shows the Log Error tab only for the admin role, even when a non-admin carries view_error_logs', () => {
    expect(canSeeNav('errors', 'view_error_logs', { role: 'admin', permissions: [] })).toBe(true)
    expect(canSeeNav('errors', 'view_error_logs', { role: 'manager', permissions: ['view_reports', 'manage_users', 'view_error_logs'] })).toBe(false)
    expect(canSeeNav('errors', 'view_error_logs', { role: 'cashier', permissions: [] })).toBe(false)
    expect(canSeeNav('errors', 'view_error_logs', null)).toBe(false)
  })

  it('shows Integrasi ERP only for the admin role', () => {
    expect(canSeeNav('erpOutbox', 'manage_erp_integration', { role: 'admin', permissions: [] })).toBe(true)
    expect(canSeeNav('erpOutbox', 'manage_erp_integration', { role: 'manager', permissions: ['manage_erp_integration'] })).toBe(false)
    expect(canSeeNav('erpOutbox', 'manage_erp_integration', null)).toBe(false)
  })

  it('shows Pengguna only for the admin role, even when a manager carries manage_users', () => {
    expect(canSeeNav('users', 'manage_users', { role: 'admin', permissions: [] })).toBe(true)
    expect(canSeeNav('users', 'manage_users', { role: 'manager', permissions: ['manage_users'] })).toBe(false)
    expect(canSeeNav('users', 'manage_users', null)).toBe(false)
  })

  it('lets only the admin, or the outlet owner, edit an outlet', () => {
    expect(canEditOutlet({ role: 'admin', outletId: null }, 'o-b')).toBe(true)
    expect(canEditOutlet({ role: 'manager', outletId: 'O-A' }, 'o-a')).toBe(true)
    expect(canEditOutlet({ role: 'manager', outletId: 'o-a' }, 'o-b')).toBe(false)
    expect(canEditOutlet({ role: 'manager', outletId: null }, 'o-a')).toBe(false)
    expect(canEditOutlet(null, 'o-a')).toBe(false)
  })

  it('keeps the existing alternate permissions for Inventori and Laporan', () => {
    expect(canSeeNav('warehouses', 'manage_inventory', { role: 'manager', permissions: ['manage_stock_count'] })).toBe(true)
    expect(canSeeNav('approvals', 'manage_inventory', { role: 'manager', permissions: ['manage_stock_count'] })).toBe(true)
    expect(canSeeNav('approvals', 'manage_inventory', { role: 'manager', permissions: [] })).toBe(false)
    expect(canSeeNav('reports', 'view_reports', { role: 'manager', permissions: ['view_transactions'] })).toBe(true)
    expect(canSeeNav('products', 'manage_products', { role: 'manager', permissions: [] })).toBe(false)
  })

  it('shows Permintaan Barang to outlet requesters and the warehouse, not to others', () => {
    expect(canSeeNav('requisitions', 'request_stock', { role: 'cashier', permissions: ['request_stock'] })).toBe(true)
    expect(canSeeNav('requisitions', 'request_stock', { role: 'manager', permissions: ['manage_inventory'] })).toBe(true)
    expect(canSeeNav('requisitions', 'request_stock', { role: 'manager', permissions: ['manage_stock_count'] })).toBe(false)
    expect(canSeeNav('requisitions', 'request_stock', { role: 'admin', permissions: [] })).toBe(true)
    expect(canSeeNav('requisitions', 'request_stock', null)).toBe(false)
  })
})
