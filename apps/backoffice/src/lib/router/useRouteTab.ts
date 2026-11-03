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
  const { path, query } = useRoute()
  const active = activeTab(tabs, segmentAfter(path, base))
  const select = useCallback(
    (key: K) => {
      const slug = slugForTab(tabs, key)
      // Clicking the tab a bare path already shows only spells the URL out: no new history entry. Anywhere deeper
      // (a filtered list, a detail) the click is a real move and keeps the entry it leaves.
      const bare = path.length === base.length && Object.keys(query).length === 0
      if (slug !== undefined) void navigate(buildHash([...base, slug]), { replace: bare && key === active })
    },
    [base, tabs, active, path, query],
  )
  return [active, select]
}
