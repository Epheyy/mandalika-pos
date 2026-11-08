import { useCallback, useEffect, useRef, useState } from 'react'
import type { IngredientStockCount, IngredientStockCountItem } from '@mandalika/api'
import { api } from '../../api'

/**
 * The list endpoint deliberately returns `items: []` for every count; only the detail endpoint carries the lines.
 * This keeps the detail of every in-progress count (needed for the "x/y dihitung" counter, Simpan and Selesai)
 * and of the expanded count. A detail that has not loaded is never reported as an empty count.
 */
export interface CountDetail {
  items: IngredientStockCountItem[] | null // null = not loaded yet
  loading: boolean
  error: string | null
}

const NOT_LOADED: CountDetail = { items: null, loading: false, error: null }

export function useIngredientCountDetails(
  counts: ReadonlyArray<Pick<IngredientStockCount, 'id' | 'status'>>,
  expandedId: string | null,
) {
  const [details, setDetails] = useState<Record<string, CountDetail>>({})
  const requests = useRef<Record<string, number>>({})

  const load = useCallback(async (id: string) => {
    const token = (requests.current[id] ?? 0) + 1
    requests.current[id] = token
    // Keep the lines we already have while refreshing, so a refresh never flashes an empty count.
    setDetails((d) => ({ ...d, [id]: { items: d[id]?.items ?? null, loading: true, error: null } }))
    try {
      const sc = await api.getIngredientStockCount(id)
      if (requests.current[id] !== token) return
      setDetails((d) => ({ ...d, [id]: { items: sc.items ?? [], loading: false, error: null } }))
    } catch (e: unknown) {
      if (requests.current[id] !== token) return
      const error = e instanceof Error ? e.message : 'Gagal memuat rincian opname.'
      setDetails((d) => ({ ...d, [id]: { items: d[id]?.items ?? null, loading: false, error } }))
    }
  }, [])

  // Reload when the set of wanted counts, or a count's status, changes (start, complete, cancel).
  const wantedKey = counts
    .filter((c) => c.status === 'in_progress' || c.id === expandedId)
    .map((c) => `${c.id}:${c.status}`)
    .join('|')

  useEffect(() => {
    if (!wantedKey) return
    for (const part of wantedKey.split('|')) void load(part.slice(0, part.indexOf(':')))
  }, [wantedKey, load])

  const detailOf = (id: string): CountDetail => details[id] ?? NOT_LOADED
  return { detailOf, reload: load }
}
