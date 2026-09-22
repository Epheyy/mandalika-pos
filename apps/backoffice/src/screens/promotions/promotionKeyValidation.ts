import { promotionHasKeyOverlap } from '@mandalika/types'
import type { PromotionInput } from '@mandalika/api'

export function promotionKeyError(p: PromotionInput): string | null {
  if (!promotionHasKeyOverlap(p)) return null
  return p.type === 'bundle'
    ? 'Produk atau varian tidak boleh dipakai di lebih dari satu slot.'
    : 'Produk atau varian beli dan hadiah tidak boleh tumpang tindih. Kosongkan produk hadiah untuk mode set yang sama.'
}
