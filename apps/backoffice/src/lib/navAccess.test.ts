import { describe, expect, it } from 'vitest'
import { canSeeNav } from './navAccess'

describe('canSeeNav', () => {
  it('canSeeNav shows the Log Error tab only for the admin role, even when a non-admin carries view_error_logs', () => {
    expect(canSeeNav('errors', 'view_error_logs', { role: 'admin', permissions: [] })).toBe(true)
    expect(canSeeNav('errors', 'view_error_logs', { role: 'manager', permissions: ['view_reports', 'manage_users', 'view_error_logs'] })).toBe(false)
    expect(canSeeNav('errors', 'view_error_logs', { role: 'cashier', permissions: [] })).toBe(false)
    expect(canSeeNav('errors', 'view_error_logs', null)).toBe(false)
  })

  it('keeps the existing alternate permissions for Inventori and Laporan', () => {
    expect(canSeeNav('warehouses', 'manage_inventory', { role: 'manager', permissions: ['manage_stock_count'] })).toBe(true)
    expect(canSeeNav('reports', 'view_reports', { role: 'manager', permissions: ['view_transactions'] })).toBe(true)
    expect(canSeeNav('products', 'manage_products', { role: 'manager', permissions: [] })).toBe(false)
  })
})
