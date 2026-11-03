import { useCallback } from 'react'
import { buildHash } from './hash'
import { navigate } from './navigate'
import { activeTab, segmentAfter, slugForTab, type PathTab } from './tabs'
import { useRoute } from './useRoute'

/**
 * A tab (or sub-tab) that lives in the hash path under `base`. The active key comes from the URL, so reload,
 * Back/Forward and a pasted link land on the same tab. `tabs` is what the user may open right now: a tab that
 * is gated on something that loads later (Bahan waits for recipesEnabled) is left out until then, and the
 * first tab shows meanwhile. Pass a stable `base` (a module constant). Choosing a tab drops the query string, which belongs to the tab it was set on.
 */
export function useRouteTab<K extends string>(
  base: readonly string[],
  tabs: readonly PathTab<K>[],
): readonly [K | undefined, (key: K) => void] {
  const { path } = useRoute()
  const active = activeTab(tabs, segmentAfter(path, base))
  const select = useCallback(
    (key: K) => {
      const slug = slugForTab(tabs, key)
      if (slug !== undefined) void navigate(buildHash([...base, slug]))
    },
    [base, tabs],
  )
  return [active, select]
}
