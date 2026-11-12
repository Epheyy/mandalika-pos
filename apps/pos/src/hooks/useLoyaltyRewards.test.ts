import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type CartItem } from '@mandalika/api'
import { previewKey } from './useLoyaltyRewards'

describe('previewKey', () => {
  const paid = { productId: 'a', variantSize: '50ml', quantity: 1 }
  it('ignores reward lines so picking a reward never refetches', () => {
    const reward = { productId: 'g', variantSize: '10ml', quantity: 1, isReward: true }
    expect(previewKey([paid, reward], 1000)).toBe(previewKey([paid], 1000))
  })
  it('changes with a paid line, its quantity or the total', () => {
    const base = previewKey([paid], 1000)
    expect(previewKey([{ ...paid, quantity: 2 }], 1000)).not.toBe(base)
    expect(previewKey([paid, { ...paid, productId: 'b' }], 1000)).not.toBe(base)
    expect(previewKey([paid], 2000)).not.toBe(base)
  })
})

describe('loyalty preview payload', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  // The server drops bundle pieces from the loyalty product set (loyaltyProductSet), keyed on these two fields, so the
  // POS must keep sending them untouched on the cart lines.
  it('sends bundleGroup and bundleRole so the server can ignore bundle pieces', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const piece: CartItem = { productId: 'big', productName: 'Big', variantSize: '50ml', price: 607948, quantity: 1, subtotal: 607948, isBundle: true, bundleGroup: 1, bundleRole: 'large' }
    const api = createClient({ baseUrl: 'http://x', getToken: () => 't' })

    await api.loyaltyPreview('cust-1', [piece], 765000)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.items[0]).toMatchObject({ productId: 'big', bundleGroup: 1, bundleRole: 'large' })
  })
})
