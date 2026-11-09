import { useEffect, useMemo, useRef, useState } from 'react'
import type { IngredientStockCount } from '@mandalika/api'
import { api } from '../../api'
import { createCountDetailLoader, idsToLoad, type CountDetail, type DetailMap } from './countDetailLoader'

export type { CountDetail }

/**
 * The list endpoint deliberately returns `items: []` for every count; only the detail endpoint carries the lines.
 * This keeps the detail of every in-progress count (needed for the "x/y dihitung" counter, Simpan and Selesai)
 * and of the expanded count. A detail that has not loaded is never reported as an empty count.
 * Opening (expanding) a count reloads it, so lines saved from another tab show up. Unsaved input lives in a
 * separate draft in the screen, so a refresh never overwrites typed values.
 */
const NOT_LOADED: CountDetail = { items: null, loading: false, error: null }

export function useIngredientCountDetails(
  counts: ReadonlyArray<Pick<IngredientStockCount, 'id' | 'status'>>,
  expandedId: string | null,
) {
  const [details, setDetails] = useState<DetailMap>({})
  const load = useMemo(() => createCountDetailLoader((id) => api.getIngredientStockCount(id), setDetails), [])
  const seen = useRef<{ key: string; expanded: string | null }>({ key: '', expanded: null })

  const wantedKey = counts
    .filter((c) => c.status === 'in_progress' || c.id === expandedId)
    .map((c) => `${c.id}:${c.status}`)
    .join('|')

  // Reload when a count enters the wanted set, changes status (start, complete, cancel) or is expanded.
  useEffect(() => {
    const prev = seen.current
    seen.current = { key: wantedKey, expanded: expandedId }
    for (const id of idsToLoad(prev.key, wantedKey, prev.expanded, expandedId)) void load(id)
  }, [wantedKey, expandedId, load])

  const detailOf = (id: string): CountDetail => details[id] ?? NOT_LOADED
  return { detailOf, reload: load }
}
