import { describe, expect, it } from 'vitest'
import { parseHash } from './hash'
import { ROUTES, SECTIONS, groupBySection, hashFor, resolveLocation, routeById, visibleRoutes } from './routes'

const admin = { role: 'admin', permissions: [] }
const manager = { role: 'manager', permissions: ['manage_products', 'view_reports'] }

describe('route table', () => {
  it('has unique ids and unique paths', () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length)
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length)
  })

  it('keeps the existing nav ids that navAccess keys on', () => {
    for (const id of ['dashboard', 'products', 'customers', 'promotions', 'reports', 'warehouses', 'approvals', 'requisitions', 'users', 'syncReview', 'settings', 'erpOutbox', 'errors']) {
      expect(routeById(id)).toBeDefined()
    }
  })

  it('uses lowercase Indonesian slugs without separators beyond "-"', () => {
    for (const r of ROUTES) expect(r.path).toMatch(/^[a-z]+(-[a-z]+)*$/)
  })

  it('puts every route in a known section, in section order (D-16)', () => {
    const order = SECTIONS.map((s) => s.id)
    let last = -1
    for (const r of ROUTES) {
      const at = order.indexOf(r.section)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(at).toBeGreaterThanOrEqual(last)
      last = at
    }
    expect(SECTIONS.map((s) => s.label)).toEqual(['Penjualan', 'Pelanggan', 'Produk & Stok', 'Operasional', 'Sistem'])
  })
})

describe('sections', () => {
  it('groups the admin sidebar into the five sections of D-16', () => {
    const groups = groupBySection(visibleRoutes(admin))
    expect(groups.map((g) => [g.section.label, g.routes.map((r) => r.id)])).toEqual([
      ['Penjualan', ['dashboard', 'reports']],
      ['Pelanggan', ['customers', 'promotions']],
      ['Produk & Stok', ['products', 'warehouses', 'approvals', 'requisitions']],
      ['Operasional', ['users', 'syncReview', 'settings']],
      ['Sistem', ['erpOutbox', 'errors']],
    ])
  })

  it('leaves out a section with nothing visible', () => {
    const groups = groupBySection(visibleRoutes(manager))
    expect(groups.map((g) => g.section.id)).toEqual(['penjualan', 'produk-stok'])
    expect(groups.flatMap((g) => g.routes.map((r) => r.id))).toEqual(['reports', 'products'])
  })
})

describe('resolveLocation', () => {
  const visible = visibleRoutes(manager)

  it('opens a visible screen by its first segment, whatever follows', () => {
    const r = resolveLocation(parseHash('#/laporan/refund?x=1'), visible)
    expect(r.kind === 'screen' && r.route.id).toBe('reports')
  })

  it('redirects an empty hash to the first visible item', () => {
    expect(resolveLocation(parseHash(''), visible)).toEqual({ kind: 'redirect', to: '#/laporan' })
  })

  it('redirects an unknown path to the first visible item', () => {
    expect(resolveLocation(parseHash('#/tidak-ada'), visible)).toEqual({ kind: 'redirect', to: '#/laporan' })
  })

  it('refuses a real screen the user cannot see', () => {
    const r = resolveLocation(parseHash('#/log-kesalahan'), visible)
    expect(r.kind === 'forbidden' && r.route.id).toBe('errors')
  })

  it('reports nothing visible when the user has no menu items', () => {
    expect(resolveLocation(parseHash(''), [])).toEqual({ kind: 'none' })
  })

  it('hashFor writes the canonical hash', () => {
    expect(hashFor(routeById('warehouses')!)).toBe('#/inventori')
  })
})
