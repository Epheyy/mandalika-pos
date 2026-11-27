import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@mandalika/api'

describe('sales staff requests (real client)', () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('listSalesStaff sends active=false and drops unset params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const api = createClient({ baseUrl: 'http://x', getToken: () => 't' })
      await api.listSalesStaff({ active: false, outletId: undefined })
      const url = new URL(String(fetchMock.mock.calls[0][0]))
      expect(url.pathname).toBe('/api/v1/sales-staff')
      expect(url.searchParams.get('active')).toBe('false')
      expect(url.searchParams.has('outletId')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('createSalesStaff sends the Idempotency-Key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ id: 's1' }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const api = createClient({ baseUrl: 'http://x', getToken: () => 't' })
      await api.createSalesStaff({ name: 'Rina', outletIds: ['o1'] } as never, 'key-1')
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-1')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
