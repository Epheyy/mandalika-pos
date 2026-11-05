import { Component, Suspense, lazy, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { UserCog } from 'lucide-react'
import type { RouteDef } from '../lib/router/routes'
import { Button } from '../ui/Button'
import { isChunkLoadError, reloadOnceForStaleChunk } from '../lib/chunkReload'

// One lazy component per screen, made once: a new lazy() each render would remount the screen every time.
const screens = new Map<string, LazyExoticComponent<ComponentType>>()

function screenFor(route: RouteDef): LazyExoticComponent<ComponentType> {
  let screen = screens.get(route.id)
  if (!screen) {
    screen = lazy(route.load)
    screens.set(route.id, screen)
  }
  return screen
}

export function LoadingFill() {
  return (
    <div role="status" className="flex h-full items-center justify-center p-12 text-sm text-ink-500">
      Memuat…
    </div>
  )
}

export function AccessDenied() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-ink-500">
      <UserCog className="h-12 w-12 text-paper-2" aria-hidden="true" />
      <p className="font-bold text-ink-700">Akses tidak diizinkan</p>
    </div>
  )
}

interface BoundaryProps {
  /** Drops the failed import and renders the screen again under a new key. */
  onRetry: () => void
  children: ReactNode
}
interface BoundaryState {
  error: Error | null
}

/**
 * A screen that fails to load (a chunk that is gone after a deploy, a dropped connection) or crashes while
 * rendering shows a message and a retry, instead of blanking the whole app. ScreenHost keys it by route and
 * attempt, so moving to another screen or retrying starts it fresh.
 */
class ScreenBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    // A missing chunk after a deploy: one full reload fetches the new index.html (guarded so it can't loop).
    if (isChunkLoadError(error)) {
      let storage: Storage | null = null
      try {
        storage = window.sessionStorage
      } catch {
        /* storage blocked */
      }
      reloadOnceForStaleChunk({ storage, reload: () => window.location.reload() })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
        <p className="font-bold text-ink-900">Halaman ini gagal dimuat.</p>
        <p className="max-w-md text-sm text-ink-700">Periksa koneksi lalu coba lagi. Jika terus gagal, muat ulang tab ini.</p>
        <p className="max-w-md break-words text-xs text-ink-500">{this.state.error.message}</p>
        <Button variant="secondary" onClick={this.props.onRetry}>
          Coba lagi
        </Button>
      </div>
    )
  }
}

/** The body of <main>: the lazy screen behind one fallback, "Memuat…". */
export function ScreenHost({ route }: { route: RouteDef }) {
  const [attempt, setAttempt] = useState(0)
  const Screen = screenFor(route)
  // React.lazy keeps a rejected import forever, so a retry drops it and remounts under a new key.
  const retry = () => {
    screens.delete(route.id)
    setAttempt((n) => n + 1)
  }
  return (
    <ScreenBoundary key={`${route.id}:${attempt}`} onRetry={retry}>
      <Suspense fallback={<LoadingFill />}>
        <Screen />
      </Suspense>
    </ScreenBoundary>
  )
}
