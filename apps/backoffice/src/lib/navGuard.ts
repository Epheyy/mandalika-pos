/*
 * Leave guards. Something with unsaved work (Pengaturan, later a dirty SlideOver) pushes a guard;
 * the router awaits confirmLeave() before it moves, and the shell awaits it before signing out.
 * A guard shows its own question and resolves true when leaving is fine.
 *
 * It is a stack: only the top guard is asked. A dirty SlideOver opened over a dirty screen is asked first,
 * so Back closes the top layer before it touches the one below.
 */
export type LeaveGuard = () => Promise<boolean>

export interface GuardOptions {
  /**
   * Path prefix the guard's screen owns, e.g. ['pengaturan']. A move that stays under it (a tab inside the same
   * screen, where the unsaved work survives) is not a leave, so the guard is not asked. Without a scope every move
   * is a leave. Moves without a destination (signing out) always ask.
   */
  scope?: readonly string[]
}

interface Entry {
  guard: LeaveGuard
  scope: readonly string[] | undefined
}

const guards: Entry[] = []

interface OpenQuestion {
  guard: LeaveGuard
  promise: Promise<boolean>
  /** Answer "stay" for a guard that went away before it was answered. */
  abandon: () => void
}
let open: OpenQuestion | null = null

const warnBeforeUnload = (e: BeforeUnloadEvent): void => {
  e.preventDefault()
  e.returnValue = ''
}

// The browser's own "Leave site?" prompt, registered only while at least one guard is active.
let unloadWarning = false
function syncUnloadWarning(): void {
  if (typeof window === 'undefined') return
  const want = guards.length > 0
  if (want === unloadWarning) return
  unloadWarning = want
  if (want) window.addEventListener('beforeunload', warnBeforeUnload)
  else window.removeEventListener('beforeunload', warnBeforeUnload)
}

/** Push a guard; returns the function that removes exactly this one. */
export function pushLeaveGuard(guard: LeaveGuard, opts: GuardOptions = {}): () => void {
  const entry: Entry = { guard, scope: opts.scope }
  guards.push(entry)
  syncUnloadWarning()
  return () => {
    const at = guards.lastIndexOf(entry)
    if (at >= 0) guards.splice(at, 1)
    syncUnloadWarning()
    // A screen that unmounts with its question still open (the session ended, say) can never answer it:
    // settle it as "stay" so nothing waits on it for the rest of the tab.
    if (open?.guard === guard) open.abandon()
  }
}

export const hasLeaveGuard = (): boolean => guards.length > 0

const isUnder = (path: readonly string[], scope: readonly string[]): boolean => scope.every((seg, i) => path[i] === seg)

/** True when moving to `target` (a path; undefined = leaving the screen altogether) must ask the top guard first. */
export function guardCovers(target?: readonly string[]): boolean {
  const top = guards[guards.length - 1]
  if (!top) return false
  return !(target && top.scope && isUnder(target, top.scope))
}

/**
 * Asks the top guard only. True when nothing is guarded or the guard allows leaving.
 * One question at a time: asking again while it is open returns the same answer instead of asking twice.
 */
export function confirmLeave(target?: readonly string[]): Promise<boolean> {
  if (open) return open.promise
  if (!guardCovers(target)) return Promise.resolve(true)
  const top = guards[guards.length - 1].guard
  let abandon!: () => void
  const abandoned = new Promise<boolean>((resolve) => {
    abandon = () => resolve(false)
  })
  const promise: Promise<boolean> = Promise.race([top(), abandoned]).finally(() => {
    if (open?.promise === promise) open = null
  })
  open = { guard: top, promise, abandon }
  return promise
}
