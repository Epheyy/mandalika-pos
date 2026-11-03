import { useMemo } from 'react'
import type { NavUser } from '../navAccess'
import { canSeeTab, routeById, tabsOf, type NavId, type RouteTab } from './routes'
import { useRouteTab } from './useRouteTab'

export interface ScreenTabs<K extends string> {
  /** The tabs this user may open, in order (route table minus permission and `hidden`). */
  tabs: readonly RouteTab<K>[]
  /** The same tabs shaped for ui/Tabs. */
  strip: ReadonlyArray<{ id: K; label: string }>
  /** The tab on show: from the URL, else the first of `tabs`. Undefined only when `tabs` is empty. */
  tab: K | undefined
  setTab: (key: K) => void
}

/**
 * The top-level tabs of a screen, read from and written to the hash path. `hidden` holds tabs the screen
 * can only decide on later (Bahan until recipesEnabled has loaded): a URL naming one falls back to the first
 * tab meanwhile and lands on it as soon as it is no longer hidden.
 */
export function useScreenTabs<K extends string>(id: NavId, user: NavUser | null, hidden: readonly K[] = []): ScreenTabs<K> {
  const hiddenKey = hidden.join(',')
  const role = user?.role
  const permissions = user?.permissions
  const tabs = useMemo(
    () => tabsOf<K>(id).filter((t) => canSeeTab(t, role === undefined ? null : { role, permissions }) && !hiddenKey.split(',').includes(t.key)),
    [id, role, permissions, hiddenKey],
  )
  const [tab, setTab] = useRouteTab(routeBase(id), tabs)
  const strip = useMemo(() => tabs.map((t) => ({ id: t.key, label: t.label })), [tabs])
  return { tabs, strip, tab, setTab }
}

const bases = new Map<NavId, readonly string[]>()
/** A stable [path] array per screen, so useRouteTab's callbacks do not change every render. */
function routeBase(id: NavId): readonly string[] {
  let base = bases.get(id)
  if (!base) {
    base = [routeById(id)?.path ?? id]
    bases.set(id, base)
  }
  return base
}
