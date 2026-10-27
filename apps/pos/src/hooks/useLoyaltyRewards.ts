import { useEffect, useMemo, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'

type Reward = components['schemas']['LoyaltyPreviewReward']
type CartItem = components['schemas']['CartItem']

const REFRESH_DELAY_MS = 400

/** What the preview depends on: the PAID lines and the total. A reward line (Rp0) is excluded so picking
 *  a reward never refetches; a changed paid line does. Pure. */
export function previewKey(cart: readonly Pick<CartItem, 'productId' | 'variantSize' | 'quantity' | 'isReward'>[], total: number): string {
  return JSON.stringify([cart.filter((c) => !c.isReward).map((c) => [c.productId, c.variantSize, c.quantity]), total])
}

/** B3: the loyalty reward preview for the attached customer, fetched in the cart (online only) so the chip can
 *  say "N hadiah tersedia" and the checkout reads the same state instead of fetching again. Refreshes (debounced)
 *  when the paid lines change, because cart-dependent rewards (spend thresholds, product purchases) move with it. */
export function useLoyaltyRewards(input: { customerId: string | null; enabled: boolean; online: boolean; cart: CartItem[]; total: number }): { rewards: Reward[]; loading: boolean } {
  const { customerId, enabled, online, cart, total } = input
  const active = enabled && online && customerId !== null
  const key = useMemo(() => previewKey(cart, total), [cart, total])
  const [done, setDone] = useState<{ customerId: string; key: string; rewards: Reward[] } | null>(null)

  useEffect(() => {
    if (!active) return
    let ignore = false
    const timer = setTimeout(() => {
      api
        .loyaltyPreview(customerId, cart, total)
        .then((r) => { if (!ignore) setDone({ customerId, key, rewards: r }) })
        .catch(() => { if (!ignore) setDone({ customerId, key, rewards: [] }) })
    }, REFRESH_DELAY_MS)
    return () => {
      ignore = true
      clearTimeout(timer)
    }
    // The key stands for cart + total (paid lines only); depending on them directly would refetch on a reward pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, customerId, key])

  if (!active) return { rewards: [], loading: false }
  const current = done !== null && done.customerId === customerId
  // Keep the last answer for this customer while a changed cart is re-asked; loading until the first one lands.
  return { rewards: current ? done.rewards : [], loading: !current || done.key !== key }
}
