import type { IngredientStockCountItem } from '@mandalika/api'

export interface CountDetail {
  items: IngredientStockCountItem[] | null // null = not loaded yet
  loading: boolean
  error: string | null
}

export type DetailMap = Record<string, CountDetail>
type Apply = (update: (d: DetailMap) => DetailMap) => void

/**
 * Loads one count's lines. Each call bumps a per-count token, so a slow older response never
 * overwrites a newer one. Lines already held are kept while refreshing (no empty flash).
 */
export function createCountDetailLoader(
  fetchCount: (id: string) => Promise<{ items?: IngredientStockCountItem[] | null }>,
  apply: Apply,
) {
  const tokens: Record<string, number> = {}
  return async (id: string): Promise<void> => {
    const token = (tokens[id] ?? 0) + 1
    tokens[id] = token
    apply((d) => ({ ...d, [id]: { items: d[id]?.items ?? null, loading: true, error: null } }))
    try {
      const sc = await fetchCount(id)
      if (tokens[id] !== token) return
      apply((d) => ({ ...d, [id]: { items: sc.items ?? [], loading: false, error: null } }))
    } catch (e: unknown) {
      if (tokens[id] !== token) return
      const error = e instanceof Error ? e.message : 'Gagal memuat rincian opname.'
      apply((d) => ({ ...d, [id]: { items: d[id]?.items ?? null, loading: false, error } }))
    }
  }
}

/**
 * Which counts to (re)load after a render. A count is loaded when it newly enters the wanted
 * set (or its status changes), and when it has just been expanded, so reopening a count shows
 * what another tab saved. `wantedKey` entries look like `id:status`.
 */
export function idsToLoad(
  prevKey: string,
  wantedKey: string,
  prevExpanded: string | null,
  expandedId: string | null,
): string[] {
  const prev = new Set(prevKey ? prevKey.split('|') : [])
  const ids: string[] = []
  for (const part of wantedKey ? wantedKey.split('|') : []) {
    const id = part.slice(0, part.indexOf(':'))
    const justExpanded = id === expandedId && id !== prevExpanded
    if (!prev.has(part) || justExpanded) ids.push(id)
  }
  return ids
}
