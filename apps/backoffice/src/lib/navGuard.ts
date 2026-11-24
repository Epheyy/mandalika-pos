/*
 * Leave guards. Something with unsaved work (Pengaturan, later a dirty SlideOver) pushes a guard;
 * the router awaits confirmLeave() before it moves, and the shell awaits it before signing out.
 * A guard shows its own question and resolves true when leaving is fine.
 *
 * It is a stack: every guard that covers the move is asked, top-down, one question at a time. A dirty SlideOver
 * opened over a dirty screen is asked first. The first "stay" stops the chain, so the guards below it are not
 * asked and nothing is lost; leaving needs every covering guard to say so.
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
  /** The guard whose question is on screen right now; only its removal abandons the chain. */
  current: LeaveGuard | null
  promise: Promise<boolean>
  /** Answer "stay" for the question being asked when its guard went away before it was answered. */
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
    if (open?.current === guard) open.abandon()
  }
}

export const hasLeaveGuard = (): boolean => guards.length > 0

const isUnder = (path: readonly string[], scope: readonly string[]): boolean => scope.every((seg, i) => path[i] === seg)

const covers = (entry: Entry, target?: readonly string[]): boolean =>
  !(target && entry.scope && isUnder(target, entry.scope))

/** True when moving to `target` (a path; undefined = leaving the screen altogether) must ask at least one guard first. */
export function guardCovers(target?: readonly string[]): boolean {
  return guards.some((entry) => covers(entry, target))
}

/**
 * Asks every guard that covers the move, top-down, stopping at the first "stay". True when nothing is guarded or
 * every covering guard allows leaving. One question at a time: asking again while the chain is open returns the
 * same answer instead of asking twice. A guard removed before its turn is skipped; a guard that already said
 * "leave" and then goes away (it saved itself) does not abandon the chain.
 */
export function confirmLeave(target?: readonly string[]): Promise<boolean> {
  if (open) return open.promise
  if (!guardCovers(target)) return Promise.resolve(true)
  const state: OpenQuestion = { current: null, promise: undefined as unknown as Promise<boolean>, abandon: () => {} }
  const run = async (): Promise<boolean> => {
    const asked = new Set<Entry>()
    for (;;) {
      const entry = nextUnasked(target, asked)
      if (!entry) return true
      asked.add(entry)
      // A fresh "abandoned" per question: a guard removed just after it answered must not settle the next one.
      const abandoned = new Promise<boolean>((resolve) => {
        state.abandon = () => resolve(false)
      })
      state.current = entry.guard
      const leave = await Promise.race([entry.guard(), abandoned])
      state.current = null
      state.abandon = () => {}
      if (!leave) return false
    }
  }
  const promise: Promise<boolean> = run().finally(() => {
    if (open === state) open = null
  })
  state.promise = promise
  open = state
  return promise
}

/** The topmost live covering guard not yet asked in this chain. */
function nextUnasked(target: readonly string[] | undefined, asked: ReadonlySet<Entry>): Entry | undefined {
  for (let i = guards.length - 1; i >= 0; i--) {
    if (!asked.has(guards[i]) && covers(guards[i], target)) return guards[i]
  }
  return undefined
}
