import type { LabelMap } from './types'

/** Derived status of a promotion or discount code (same rule as the server's `status` filter). */
export const PROMOTION_STATUS = {
  aktif: { label: 'Aktif', tone: 'ok' },
  terjadwal: { label: 'Terjadwal', tone: 'info' },
  berakhir: { label: 'Berakhir', tone: 'neutral' },
  nonaktif: { label: 'Nonaktif', tone: 'neutral' },
} as const satisfies LabelMap<string>

export const PROMOTION_TYPE = {
  percentage: { label: 'Persentase', tone: 'promo' },
  fixed: { label: 'Nominal', tone: 'promo' },
  bogo: { label: 'BOGO', tone: 'promo' },
  buy_x_get_y: { label: 'Beli-Gratis', tone: 'promo' },
  tiered: { label: 'Bertingkat', tone: 'promo' },
  bundle: { label: 'Paket Bundel', tone: 'promo' },
  bundle_discount: { label: 'Diskon Bundle', tone: 'promo' },
} as const satisfies LabelMap<string>

/** Discount codes only come in two kinds. */
export const DISCOUNT_CODE_TYPE = {
  percentage: PROMOTION_TYPE.percentage,
  fixed: PROMOTION_TYPE.fixed,
} as const satisfies LabelMap<string>
