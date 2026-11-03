/*
 * Ringkasan's period as URL state: #/ringkasan?periode=30h. The default (7 hari) stays out of the URL and any value
 * that is not a period falls back to it.
 */
import type { ListSchema } from '../../lib/router/useListState'
import type { Period } from './metrics'

export const DEFAULT_PERIOD: Period = '7d'

const SLUG_OF: Readonly<Record<Period, string>> = { today: 'hari-ini', '7d': '7h', '30d': '30h', all: 'semua' }

export const periodSlug = (period: Period): string => SLUG_OF[period]

export function periodFromSlug(slug: string): Period {
  const hit = (Object.keys(SLUG_OF) as Period[]).find((p) => SLUG_OF[p] === slug)
  return hit ?? DEFAULT_PERIOD
}

export interface DashboardQuery extends Record<string, string | number | boolean> {
  periode: string
}
export const DASHBOARD_SCHEMA: ListSchema<DashboardQuery> = {
  periode: { key: 'periode', default: SLUG_OF[DEFAULT_PERIOD] },
}
