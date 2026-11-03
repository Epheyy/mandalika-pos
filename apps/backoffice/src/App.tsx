import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './auth'
import { useOutlet } from './outlet'
import { confirmLeave } from './lib/navGuard'
import { navigate } from './lib/router/navigate'
import { groupBySection, hashFor, resolveLocation, routeById, visibleRoutes } from './lib/router/routes'
import { useRoute } from './lib/router/useRoute'
import { Header } from './shell/Header'
import { LoginScreen } from './shell/LoginScreen'
import { AccessDenied, LoadingFill, ScreenHost } from './shell/ScreenHost'
import { Sidebar } from './shell/Sidebar'
import { useNavBadges } from './shell/navBadges'

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

  // Screens that ask the shell to switch by nav id (Permintaan Barang -> Inventori). Goes away once they call navigate().
  useEffect(() => {
    const go = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail
      const route = typeof id === 'string' ? routeById(id) : undefined
      if (route) void navigate(hashFor(route))
    }
    window.addEventListener('mandalika:nav', go)
    return () => window.removeEventListener('mandalika:nav', go)
  }, [])

  // A new screen starts at the top (main is the scroll box).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [activeId])

  if (!ready) return <div className="flex min-h-screen items-center justify-center text-ink-500">Memuat…</div>
  if (!user) return <LoginScreen />

  const logoutIfAllowed = async () => {
    if (await confirmLeave()) logout()
  }

  let body
  if (!outletsReady || resolution.kind === 'redirect') body = <LoadingFill />
  else if (shown) body = <ScreenHost route={shown} />
  else body = <AccessDenied />

  return (
    <div className="flex h-screen overflow-clip bg-paper-0">
      <Sidebar
        groups={groups}
        activeId={activeId}
        badgeOf={badgeOf}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header route={shown} user={user} onOpenMenu={() => setSidebarOpen(true)} onLogout={logoutIfAllowed} />
        <main ref={mainRef} className="relative flex-1 overflow-y-auto">
          {body}
        </main>
      </div>
    </div>
  )
}
