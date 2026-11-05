import type { components } from '@mandalika/api'
import { formatRupiah, tieredNextTier } from './pricing'
import type { AutoPrompt } from './autoPromos'

type Promotion = components['schemas']['Promotion']

/**
 * One line for a tiered promo (QA P-21): what it saves now and what the next tier needs, e.g.
 * "Hemat Rp 10.000 · belanja Rp 30.000 lagi untuk hemat 15%". Null when there is no next tier to point at
 * (the caller keeps the plain "hemat" fragment then).
 */
export function tieredOneLiner(promo: Pick<Promotion, 'type' | 'tieredConfig'>, subtotal: number, savings: number): string | null {
  if (promo.type !== 'tiered') return null
  const next = tieredNextTier(promo.tieredConfig, subtotal)
  if (!next) return null
  const gain = next.kind === 'percentage' ? `hemat ${next.value}%` : `potongan ${formatRupiah(next.value)}`
  const goal = `belanja ${formatRupiah(next.gap)} lagi untuk ${gain}`
  return savings > 0 ? `Hemat ${formatRupiah(savings)} · ${goal}` : goal.charAt(0).toUpperCase() + goal.slice(1)
}

/** The cart's quiet row for a qualifying auto promo that needs the cashier (gift to choose, or no stock). */
export function autoPromptLabel(p: AutoPrompt): string {
  return p.reason === 'pick-gift' ? `Promo ${p.promotionName} berlaku · Pilih hadiah` : `Promo ${p.promotionName} berlaku · Stok hadiah habis`
}
