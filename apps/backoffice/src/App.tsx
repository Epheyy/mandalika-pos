import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './auth'
import { useOutlet } from './outlet'
import { confirmLeave } from './lib/navGuard'
import { navigate } from './lib/router/navigate'
import { groupBySection, resolveLocation, visibleRoutes } from './lib/router/routes'
import { useRoute } from './lib/router/useRoute'
import { Header } from './shell/Header'
import { LoginScreen } from './shell/LoginScreen'
import { AccessDenied, LoadingFill, ScreenHost } from './shell/ScreenHost'
import { Sidebar } from './shell/Sidebar'
import { useNavBadges } from './shell/navBadges'
import { useScrollRestore } from './shell/useScrollRestore'

export default function App() {
  const { user, ready, logout } = useAuth()
  const { outletId, outletsReady } = useOutlet()
  const loc = useRoute()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)

  const visible = useMemo(() => visibleRoutes(user), [user])
  const groups = useMemo(() => groupBySection(visible), [visible])
  const resolution = useMemo(() => resolveLocation(loc, visible), [loc, visible])
  const badgeOf = useNavBadges(visible, user, outletId)

  const shown = resolution.kind === 'screen' ? resolution.route : null
  const activeId = shown?.id ?? null

  // An empty or unknown hash opens the first menu item the user can see, replacing the entry (no dead Back step).
  useEffect(() => {
    if (user && resolution.kind === 'redirect') void navigate(resolution.to, { replace: true })
  }, [user, resolution])

  // main is the scroll box: a new place starts at the top, Back/Forward restores where the entry was.
  useScrollRestore(mainRef)

  if (!ready) return <div className="flex min-h-screen items-center justify-center bg-paper-0 text-ink-500">Memuat…</div>
  if (!user) return <LoginScreen />

  const logoutIfAllowed = async () => {
    if (await confirmLeave()) logout()
  }

  let body
  if (!outletsReady || resolution.kind === 'redirect') body = <LoadingFill />
  else if (shown) body = <ScreenHost route={shown} />
  else body = <AccessDenied />

  return (
    // The root keeps bg-paper-0: it will hide the ambient layer once a later slice turns the ambient on.
    <div className="flex h-screen overflow-clip bg-paper-0">
      {/* First focusable element. A button, not a #link: the hash is the router's. */}
      <button
        type="button"
        onClick={() => mainRef.current?.focus()}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-xl focus:bg-brand-strong focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-on-brand focus:outline-none focus:ring-2 focus:ring-ink-900"
      >
        Lewati ke konten
      </button>
      <Sidebar
        groups={groups}
        activeId={activeId}
        badgeOf={badgeOf}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header route={shown} user={user} onOpenMenu={() => setSidebarOpen(true)} onLogout={logoutIfAllowed} />
        <main id="konten" ref={mainRef} tabIndex={-1} className="relative flex-1 overflow-y-auto focus:outline-none [scrollbar-gutter:stable]">
          {body}
        </main>
      </div>
    </div>
  )
}
