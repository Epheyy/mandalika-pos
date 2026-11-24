import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Outlet } from '@mandalika/api'

const outlets: Outlet[] = [
  { id: 'o1', name: 'Outlet Baru', code: 'NEW1', isActive: false, timezone: 'Asia/Jakarta', createdAt: '2026-11-24T00:00:00Z', setupPending: true },
  { id: 'o2', name: 'Outlet Lama', code: 'OLD1', isActive: true, timezone: 'Asia/Jakarta', createdAt: '2026-11-24T00:00:00Z', setupPending: false },
]

vi.mock('../../hooks/usePolledQuery', () => ({
  usePolledQuery: () => ({ data: outlets, error: null, loading: false, refetch: async () => {} }),
}))
vi.mock('../../outlet', () => ({ useOutlet: () => ({ refreshOutlets: () => {} }) }))
vi.mock('../../auth', () => ({ useAuth: () => ({ user: { role: 'admin' } }) }))
vi.mock('../../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api')>()) }))

import { LocationsSection } from './LocationsSection'

describe('LocationsSection ERP setup badge', () => {
  const html = renderToStaticMarkup(<LocationsSection />)

  it('marks an outlet created by the ERP that is not set up yet', () => {
    expect(html.match(/Dari ERP · belum diatur/g)).toHaveLength(1)
  })

  it('shows the badge next to the pending outlet only', () => {
    const pending = html.indexOf('Outlet Baru')
    const badge = html.indexOf('Dari ERP · belum diatur')
    const other = html.indexOf('Outlet Lama')
    expect(badge).toBeGreaterThan(pending)
    expect(badge).toBeLessThan(other)
  })
})
