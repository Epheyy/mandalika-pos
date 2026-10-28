// C5 (D-19): framework-free state for the "Versi baru siap" prompt, so it is unit-testable without a DOM.
// useOtaUpdate wraps it with useSyncExternalStore. The controller only reloads from restart(), and
// restart() re-reads the sale state at call time: a stale render can never apply an update mid-sale.

import type { OtaPending, OtaWatch } from '../otaUpdate'
import { otaBlockReason, type OtaBlockReason, type OtaGateInput } from './otaApplyGate'

export interface OtaUpdateState {
  pending: OtaPending | null
  applying: boolean
  error: string | null
}

export type OtaRestartResult = 'none' | 'busy' | 'blocked' | 'failed' | 'not-reloaded'

export const OTA_RESTART_ERROR = 'Gagal memulai ulang. Coba lagi.'

export interface OtaUpdateController {
  start(): void
  stop(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): OtaUpdateState
  restart(readGate: () => OtaGateInput): Promise<OtaRestartResult>
  /** Why a restart must wait right now, from the same gate restart() uses. */
  blockReason(readGate: () => OtaGateInput): OtaBlockReason | null
}

export function createOtaUpdateController(deps: { watch: OtaWatch; reload: () => Promise<void> }): OtaUpdateController {
  let state: OtaUpdateState = { pending: null, applying: false, error: null }
  const listeners = new Set<() => void>()
  let unwatch: (() => void) | null = null
  let generation = 0

  const set = (next: OtaUpdateState) => {
    state = next
    listeners.forEach((l) => l())
  }

  return {
    start() {
      if (unwatch) return
      const mine = ++generation
      unwatch = () => {}
      void deps.watch((pending) => {
        if (mine !== generation) return
        // The same version is re-announced on every foreground check: keep the snapshot identity stable.
        if (state.pending?.version === pending.version) return
        set({ ...state, pending, error: null })
      }).then(
        (off) => {
          if (mine === generation) unwatch = off
          else off()
        },
        () => {},
      )
    },
    stop() {
      generation++
      const off = unwatch
      unwatch = null
      off?.()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    getSnapshot: () => state,
    blockReason: (readGate) => otaBlockReason(readGate()),
    async restart(readGate) {
      if (!state.pending) return 'none'
      if (state.applying) return 'busy'
      if (otaBlockReason(readGate()) !== null) return 'blocked'
      set({ ...state, applying: true, error: null })
      try {
        await deps.reload()
        // Reaching here means the WebView was not replaced (web, or the plugin declined): not applied.
        set({ ...state, applying: false })
        return 'not-reloaded'
      } catch {
        set({ ...state, applying: false, error: OTA_RESTART_ERROR })
        return 'failed'
      }
    },
  }
}
