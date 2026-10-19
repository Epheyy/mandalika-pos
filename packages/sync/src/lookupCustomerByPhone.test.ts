import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from '@mandalika/api'

// A30: the cashier's customer finder sends the typed phone as ?phone= (never ?q=) and
// surfaces the server's 429 as a typed ApiError the POS picker can show.
function client() {
  return createClient({ baseUrl: 'https://api.example.invalid', getToken: () => 'tok' })
}

afterEach(() => vi.unstubAllGlobals())

describe('lookupCustomerByPhone', () => {
  it('calls the lookup endpoint with phone and returns the rows', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'c1', name: 'Alice', phone: '081234567890', points: 3 }], meta: { total: 1, page: 1, limit: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await client().lookupCustomerByPhone('+62 812-3456-7890')

    expect(rows.map((r) => r.id)).toEqual(['c1'])
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]))
    expect(url.pathname).toBe('/api/v1/sync/customers/lookup')
    expect(url.searchParams.get('phone')).toBe('+62 812-3456-7890')
    expect(url.searchParams.has('q')).toBe(false)
  })

  it('throws an ApiError with status 429 when the lookup budget is exhausted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'terlalu banyak pencarian' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
        }),
      ),
    )

    await expect(client().lookupCustomerByPhone('081234567890')).rejects.toMatchObject({ status: 429 })
    await expect(client().lookupCustomerByPhone('081234567890')).rejects.toBeInstanceOf(ApiError)
  })
})
