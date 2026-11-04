/** One-time full reload when a deploy has removed the hashed chunk a stale tab still points at. */
export const CHUNK_RELOAD_KEY = 'mandalika:chunk-reloaded'

/** No second reload inside this window, so a chunk that stays missing cannot loop the page. */
export const RELOAD_COOLDOWN_MS = 60_000

interface ReloadDeps {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  reload: () => void
  now?: () => number
  /** False when the browser is offline: a failed import is then a network drop, not a stale deploy. */
  isOnline?: () => boolean
}

/** Reloads at most once per cooldown window; returns whether it reloaded. Never throws (storage may be blocked). */
export function reloadOnceForStaleChunk({ storage, reload, now = Date.now, isOnline = () => navigator.onLine !== false }: ReloadDeps): boolean {
  if (!isOnline()) return false
  try {
    if (!storage) return false
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY))
    if (Number.isFinite(last) && last > 0 && now() - last < RELOAD_COOLDOWN_MS) return false
    storage.setItem(CHUNK_RELOAD_KEY, String(now()))
  } catch {
    return false
  }
  reload()
  return true
}

/** True for the errors a missing lazy chunk raises (Chrome, Firefox, Safari wording). */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk .* failed/i.test(msg)
}

/** Registers the Vite preload-error hook (one reload per cooldown window). */
export function installChunkReloadGuard(): void {
  const storage = (() => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  })()
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForStaleChunk({ storage, reload: () => window.location.reload() })) event.preventDefault()
  })
}
