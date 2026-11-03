/*
 * The history engine behind useRoute / navigate / Link.
 *
 * Every history entry the router creates carries { idx }. That is how a Back or Forward that the browser
 * already performed is told apart (lower idx = Back, higher = Forward, no idx = a typed URL or plain anchor,
 * which the browser always treats as a push), and how it is undone with history.go() when a leave guard
 * refuses: go() keeps the Forward entries, pushState() would cut them off.
 *
 * The engine talks to the browser only through HistoryEnv, so tests drive it with a fake history stack.
 */
import { confirmLeave, guardCovers } from '../navGuard'
import { EMPTY_LOCATION, normalizeHash, parseHash, type Location } from './hash'

export interface HistoryEnv {
  hash(): string
  /** The idx stamped on the current history entry, or null for an entry the router did not create. */
  stateIdx(): number | null
  /** Stamp the current entry without changing its URL. */
  stamp(idx: number): void
  push(idx: number, hash: string): void
  replace(idx: number, hash: string): void
  go(delta: number): void
  /** Called after every popstate/hashchange. Returns the unsubscribe. */
  listen(onChange: () => void): () => void
}

export interface NavigateOptions {
  replace?: boolean
}

/** How the router got to the new entry: a push or replace it made itself, or the browser moving along history. */
export type MoveKind = 'push' | 'replace' | 'pop'

/** One committed move, handed to move listeners before the screen re-renders (the old screen is still on show). */
export interface RouteMove {
  kind: MoveKind
  from: { idx: number; path: readonly string[] }
  to: { idx: number; path: readonly string[] }
}

export interface Router {
  getLocation(): Location
  /** Resolves true when the move happened, false when a leave guard refused or a question is already open. */
  navigate(to: string, opts?: NavigateOptions): Promise<boolean>
  subscribe(listener: () => void): () => void
  /** Called synchronously on every committed move, before subscribers re-render. */
  subscribeMoves(listener: (move: RouteMove) => void): () => void
  /** The hash of the entry right before the current one, when the router created it in this page load. */
  previousHash(): string | undefined
  /**
   * In-app "Kembali": when the previous entry satisfies `matches` (the list the user came from) step back to it, so
   * its filters, page and scroll are still there; otherwise navigate to `fallback`. Asks the leave guard like any move.
   */
  back(fallback: string, matches: (path: readonly string[]) => boolean, fallbackOpts?: NavigateOptions): Promise<boolean>
}

const SETTLE_TIMEOUT_MS = 1000

export function createRouter(env: HistoryEnv): Router {
  const listeners = new Set<() => void>()
  const moveListeners = new Set<(move: RouteMove) => void>()
  // idx -> hash of the entries this page load has seen, to know what a step back lands on.
  const seen = new Map<number, string>()
  let committed = normalizeHash(env.hash())
  let location: Location = parseHash(committed)
  let idx = env.stateIdx() ?? 0
  if (env.stateIdx() === null) env.stamp(idx)
  seen.set(idx, committed)

  // True while a leave question is open: further moves are refused or put back.
  let asking = false
  // The next external change is the traversal we issued ourselves after the guard said yes.
  let expectTraversal = false
  let traversalTimer: ReturnType<typeof setTimeout> | undefined

  const commit = (hash: string, at: number, kind: MoveKind): void => {
    const from = { idx, path: location.path }
    committed = normalizeHash(hash)
    location = parseHash(committed)
    idx = at
    if (kind === 'push') for (const k of [...seen.keys()]) if (k >= at) seen.delete(k)
    seen.set(at, committed)
    const move: RouteMove = { kind, from, to: { idx: at, path: location.path } }
    for (const l of [...moveListeners]) l(move)
    for (const l of [...listeners]) l()
  }

  /** The browser is somewhere we did not put it and nothing guards the screen: follow it. */
  const adopt = (): void => {
    const at = env.stateIdx()
    if (at === null) {
      // A typed URL or plain anchor: always a push from the entry we were on.
      env.stamp(idx + 1)
      commit(env.hash(), idx + 1, 'push')
      return
    }
    commit(env.hash(), at, at === idx ? 'replace' : 'pop')
  }

  // An entry with no idx is never settled, even at our hash: a typed alias of the current hash is a new entry.
  const isSettled = (): boolean => normalizeHash(env.hash()) === committed && env.stateIdx() === idx

  const waitSettled = (): Promise<void> =>
    new Promise((resolve) => {
      if (isSettled()) return resolve()
      const done = (): void => {
        off()
        clearTimeout(timer)
        resolve()
      }
      const off = env.listen(() => {
        if (isSettled()) done()
      })
      const timer = setTimeout(done, SETTLE_TIMEOUT_MS)
    })

  const undo = async (): Promise<void> => {
    if (isSettled()) return
    const at = env.stateIdx()
    if (at === null) env.go(-1)
    else if (at !== idx) env.go(idx - at)
    else env.replace(idx, committed)
    await waitSettled()
  }

  // One undo at a time: a Back arrives as popstate and then hashchange, and a second go() would overshoot.
  let undoing: Promise<void> | null = null
  /** Put the browser back on the entry the screen is showing. */
  const restore = (): Promise<void> => (undoing ??= undo().finally(() => { undoing = null }))

  const guardedExternal = async (targetHash: string, targetIdx: number | null): Promise<void> => {
    asking = true
    let leave = false
    try {
      await restore()
      leave = await confirmLeave(parseHash(targetHash).path)
    } finally {
      asking = false
    }
    if (!leave) return
    if (targetIdx !== null && targetIdx !== idx) {
      expectTraversal = true
      clearTimeout(traversalTimer)
      traversalTimer = setTimeout(() => { expectTraversal = false }, SETTLE_TIMEOUT_MS)
      env.go(targetIdx - idx)
      return
    }
    // A typed URL (or a stamp equal to ours): re-issue it as a push.
    env.push(idx + 1, targetHash)
    commit(targetHash, idx + 1, 'push')
  }

  const onExternal = (): void => {
    if (expectTraversal) {
      expectTraversal = false
      clearTimeout(traversalTimer)
      adopt()
      return
    }
    if (isSettled()) return // the echo of our own go()/replace()
    if (asking) {
      void restore() // another move while a question is open: put it back, keep asking
      return
    }
    if (!guardCovers(parseHash(env.hash()).path)) {
      adopt()
      return
    }
    void guardedExternal(env.hash(), env.stateIdx())
  }
  env.listen(onExternal)

  const navigate = async (to: string, opts: NavigateOptions = {}): Promise<boolean> => {
    const target = normalizeHash(to)
    if (target === committed) return true
    if (asking) return false
    const targetPath = parseHash(target).path
    if (guardCovers(targetPath)) {
      asking = true
      let leave = false
      try {
        leave = await confirmLeave(targetPath)
      } finally {
        asking = false
      }
      if (!leave) return false
    }
    // A Back pressed during the question is still being put back: push from the entry it lands on.
    if (undoing) await undoing
    if (opts.replace) {
      env.replace(idx, target)
      commit(target, idx, 'replace')
    } else {
      env.push(idx + 1, target)
      commit(target, idx + 1, 'push')
    }
    return true
  }

  const previousHash = (): string | undefined => seen.get(idx - 1)

  const back = async (
    fallback: string,
    matches: (path: readonly string[]) => boolean,
    fallbackOpts: NavigateOptions = {},
  ): Promise<boolean> => {
    if (expectTraversal) return false // our own step back has not landed yet: a second one would overshoot
    const previous = previousHash()
    if (previous === undefined || !matches(parseHash(previous).path)) return navigate(fallback, fallbackOpts)
    if (asking) return false
    const targetPath = parseHash(previous).path
    if (guardCovers(targetPath)) {
      asking = true
      let leave = false
      try {
        leave = await confirmLeave(targetPath)
      } finally {
        asking = false
      }
      if (!leave) return false
    }
    if (undoing) await undoing
    // The popstate of this step is ours: follow it without asking the guard again.
    expectTraversal = true
    clearTimeout(traversalTimer)
    traversalTimer = setTimeout(() => { expectTraversal = false }, SETTLE_TIMEOUT_MS)
    env.go(-1)
    return true
  }

  return {
    getLocation: () => location,
    navigate,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeMoves(listener) {
      moveListeners.add(listener)
      return () => {
        moveListeners.delete(listener)
      }
    },
    previousHash,
    back,
  }
}

// ---- the browser binding -------------------------------------------------------------------------------

const browserEnv: HistoryEnv = {
  hash: () => window.location.hash,
  stateIdx: () => {
    const state = window.history.state as { idx?: unknown } | null
    return typeof state?.idx === 'number' ? state.idx : null
  },
  stamp: (idx) => window.history.replaceState({ idx }, ''),
  push: (idx, hash) => window.history.pushState({ idx }, '', hash),
  replace: (idx, hash) => window.history.replaceState({ idx }, '', hash),
  go: (delta) => window.history.go(delta),
  listen: (onChange) => {
    window.addEventListener('popstate', onChange)
    window.addEventListener('hashchange', onChange)
    return () => {
      window.removeEventListener('popstate', onChange)
      window.removeEventListener('hashchange', onChange)
    }
  },
}

let shared: Router | null = null
const sharedRouter = (): Router => (shared ??= createRouter(browserEnv))

export const navigate = (to: string, opts?: NavigateOptions): Promise<boolean> => sharedRouter().navigate(to, opts)
export const subscribeRoute = (listener: () => void): (() => void) => sharedRouter().subscribe(listener)
export const subscribeMoves = (listener: (move: RouteMove) => void): (() => void) => sharedRouter().subscribeMoves(listener)
export const getRouteLocation = (): Location => sharedRouter().getLocation()
export const previousRouteHash = (): string | undefined => sharedRouter().previousHash()
export const backOrNavigate = (
  fallback: string,
  matches: (path: readonly string[]) => boolean,
  fallbackOpts?: NavigateOptions,
): Promise<boolean> => sharedRouter().back(fallback, matches, fallbackOpts)
/** What renders on the server and under renderToStaticMarkup, where there is no window. */
export const getServerRouteLocation = (): Location => EMPTY_LOCATION
