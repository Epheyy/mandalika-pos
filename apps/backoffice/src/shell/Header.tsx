import { ChevronRight, Menu } from 'lucide-react'
import type { User } from '@mandalika/api'
import { OutletSwitcher } from '../outlet'
import { sectionLabel, tabForPath, type RouteDef } from '../lib/router/routes'
import { useRoute } from '../lib/router/useRoute'
import { UserMenu } from './UserMenu'

interface HeaderProps {
  /** The screen on show, or null while redirecting or when access is refused. */
  route: RouteDef | null
  user: User
  onOpenMenu: () => void
  onLogout: () => void | Promise<void>
}

export function Header({ route, user, onOpenMenu, onLogout }: HeaderProps) {
  const { path } = useRoute()
  // Screens with tabs add the tab on show: a bare path means the first tab this user may open.
  const tabRaw = route ? tabForPath(route, path, user) : undefined
  // A tab named like its screen ("Produk › Produk") adds nothing: show the third level only when it says something new.
  const tab = tabRaw && tabRaw.label !== route?.label ? tabRaw : undefined
  return (
    // Real glass: <main> scrolls under this bar (the only blurred layer in the backoffice, plan 5.1). z-[25] sits above
    // every popover inside <main> (z-10/z-20) and below the drawer scrim (z-[26]), the drawer (z-30) and dialogs (z-50).
    <header className="surface-glass absolute left-0 right-(--bo-sb) top-0 z-[25] flex h-(--bo-topbar-h) items-center gap-2 rounded-[20px] px-3 sm:gap-4 sm:px-5">
      <button
        type="button"
        aria-label="Buka menu"
        onClick={onOpenMenu}
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl hover:bg-paper-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong lg:hidden"
      >
        <Menu className="h-5 w-5 text-ink-700" aria-hidden="true" />
      </button>
      <nav aria-label="Posisi halaman" className="min-w-0">
        {route && (
          <ol className="flex items-center gap-1.5 text-sm text-ink-700">
            <li className="max-sm:sr-only">{sectionLabel(route.section)}</li>
            <li aria-hidden="true" className="flex max-sm:sr-only">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li aria-current={tab ? undefined : 'page'} className={tab ? 'truncate max-sm:sr-only' : 'truncate font-semibold text-ink-900'}>
              {route.label}
            </li>
            {tab && (
              <>
                <li aria-hidden="true" className="flex max-sm:sr-only">
                  <ChevronRight className="h-3.5 w-3.5" />
                </li>
                <li aria-current="page" className="truncate font-semibold text-ink-900" title={tab.label}>
                  {tab.label}
                </li>
              </>
            )}
          </ol>
        )}
      </nav>
      {/* Never shrinks, so on a phone the breadcrumb gives way and both controls stay on screen (SH-07). */}
      <div className="ml-auto flex flex-shrink-0 items-center gap-2 sm:gap-3">
        <OutletSwitcher />
        <UserMenu user={user} onLogout={onLogout} />
      </div>
    </header>
  )
}
