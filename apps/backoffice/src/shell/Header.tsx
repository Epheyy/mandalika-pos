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
  const tab = route ? tabForPath(route, path, user) : undefined
  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-4 border-b border-paper-2 bg-white px-4 sm:px-8">
      <button
        type="button"
        aria-label="Buka menu"
        onClick={onOpenMenu}
        className="rounded-xl p-2 hover:bg-paper-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong lg:hidden"
      >
        <Menu className="h-5 w-5 text-ink-700" aria-hidden="true" />
      </button>
      <nav aria-label="Posisi halaman">
        {route && (
          <ol className="flex items-center gap-1.5 text-[13px] text-ink-500">
            <li>{sectionLabel(route.section)}</li>
            <li aria-hidden="true" className="flex">
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li aria-current={tab ? undefined : 'page'} className={tab ? undefined : 'font-semibold text-ink-900'}>
              {route.label}
            </li>
            {tab && (
              <>
                <li aria-hidden="true" className="flex">
                  <ChevronRight className="h-3.5 w-3.5" />
                </li>
                <li aria-current="page" className="font-semibold text-ink-900">
                  {tab.label}
                </li>
              </>
            )}
          </ol>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <OutletSwitcher />
        <UserMenu user={user} onLogout={onLogout} />
      </div>
    </header>
  )
}
