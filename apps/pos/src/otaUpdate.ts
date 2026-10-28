// C5 (D-19): the Capgo glue for the "Versi baru siap" prompt. Kept out of native.ts on purpose: that file
// owns the single OTA-ready confirm (A35), and App-level tests mock it with a fixed export list.
//
// The updater stays in its default `autoUpdate: true` mode (no native/APK change): it downloads in the
// background, emits `updateAvailable` and queues the bundle as "next". This module OBSERVES that queue and,
// when the cashier taps "Mulai ulang sekarang", calls reload() to apply the already-queued bundle. Nothing
// here ever applies an update on its own. Everything is a no-op off-device and never throws.
//
// Capgo would also apply the queued bundle the moment the app goes to the background (installNext), which
// reloads the WebView and drops an open cart if the cashier switches to an EDC/e-wallet app mid-checkout.
// armOtaKillDelay() blocks that: while a `kill` delay condition is stored, installNext returns early. The
// condition is persisted natively but cleared on every launch (load() and onDestroy run checkCancelDelay
// KILLED), so it is re-armed from JS on every launch, and again on each `updateAvailable`. reload() does not
// look at delay conditions, so the "Mulai ulang sekarang" path still applies the queued bundle.
// Consequence (verified in the 8.50.2 source): installNext on background is the ONLY automatic apply and a
// cold start applies nothing, so with the delay armed a queued bundle would wait for the button forever.
// startupOta() therefore applies it ONCE on a cold start, from boot() before storage hydrate and before any
// UI or cart exists (the app was fully closed): an update applies on the next launch, or when the cashier
// taps the button, never on backgrounding. Guards: nothing usable queued, the queued id is the running one,
// the current bundle is not yet confirmed (status != success), or a persistent per-bundle marker says an
// apply was already tried (a failed native reload re-loads the WebView and would otherwise loop).
// (directUpdateFinish also ignores delays; unused here: no `directUpdate`.)

import { Capacitor } from '@capacitor/core'

export interface OtaPending {
  version: string
}

export type OtaWatch = (onReady: (pending: OtaPending) => void) => Promise<() => void>

interface BundleView {
  id: string
  status?: string
}

export type ColdApplyDecision = 'apply' | 'none' | 'builtin' | 'unusable' | 'same' | 'current-unconfirmed' | 'already-tried'

/** Pure: may the queued bundle be applied now, at a cold start? */
export function decideColdApply(o: { next: BundleView | null | undefined; current: BundleView | null | undefined; triedId: string | null }): ColdApplyDecision {
  const { next, current, triedId } = o
  if (!next?.id) return 'none'
  if (next.id === BUILTIN_BUNDLE_ID) return 'builtin'
  if (next.status !== 'pending' && next.status !== 'success') return 'unusable'
  if (!current?.id) return 'current-unconfirmed'
  if (next.id === current.id) return 'same'
  // A freshly applied bundle is `pending` until notifyAppReady; reloading away from it is not ours to decide.
  if (current.id !== BUILTIN_BUNDLE_ID && current.status !== 'success') return 'current-unconfirmed'
  if (triedId === next.id) return 'already-tried'
  return 'apply'
}

const TRIED_KEY = 'mandalika.pos.otaColdApplyTried'
const STEP_TIMEOUT_MS = 1500
const RELOAD_WAIT_MS = 8000
const RELOAD_SETTLE_MS = 2000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Bound a bridge call: boot must never hang on the updater. */
const bounded = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), sleep(ms).then(() => fallback)])

/** The bundle id a cold apply was already attempted for. `undefined` = storage unavailable (then never apply). */
function readTried(): string | null | undefined {
  try {
    return globalThis.localStorage.getItem(TRIED_KEY)
  } catch {
    return undefined
  }
}
function writeTried(id: string): boolean {
  try {
    globalThis.localStorage.setItem(TRIED_KEY, id)
    return globalThis.localStorage.getItem(TRIED_KEY) === id
  } catch {
    return false
  }
}

const BUILTIN_BUNDLE_ID = 'builtin'
const noop = () => {}

/** Stop Capgo applying a queued bundle on background; only the gated button (reload) applies it. Native only, never throws. */
export async function armOtaKillDelay(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    await armWith(CapacitorUpdater)
  } catch {
    /* plugin absent or older shell: the old background-apply rule stays */
  }
}

const armWith = (plugin: { setMultiDelay(o: { delayConditions: Array<{ kind: 'kill' }> }): Promise<void> }) =>
  plugin.setMultiDelay({ delayConditions: [{ kind: 'kill' }] })

/**
 * Boot step, first thing in boot(): arm the kill delay, then apply a bundle queued by an earlier session once.
 * Always resolves (bounded), never throws, no-op off-device. If it requests a reload it waits for the WebView
 * to be replaced instead of continuing into storage hydrate; if the reload does not happen, boot continues.
 */
export async function startupOta(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    // One bounded import, reused for arm + probe + reload: boot never waits on the plugin chunk unboundedly.
    const mod = await bounded(import('@capgo/capacitor-updater'), STEP_TIMEOUT_MS, null)
    if (!mod) return
    const { CapacitorUpdater } = mod
    await bounded(armWith(CapacitorUpdater), STEP_TIMEOUT_MS, undefined)
    const probe = Promise.all([CapacitorUpdater.getNextBundle(), CapacitorUpdater.current()]).then(([next, cur]) => ({ next, current: cur.bundle }))
    const seen = await bounded(probe, STEP_TIMEOUT_MS, null)
    const triedId = readTried()
    if (!seen || triedId === undefined) return
    if (decideColdApply({ next: seen.next, current: seen.current, triedId }) !== 'apply') return
    // Marker BEFORE the reload: if the native reload fails and re-enters boot(), this id is never retried.
    if (!writeTried(seen.next!.id)) return
    // Settle after a rejection too: a failed native reload re-loads the WebView, so this page is still dying.
    const settle = () => sleep(RELOAD_SETTLE_MS)
    const flow = CapacitorUpdater.reload().then(settle, settle)
    await Promise.race([flow, sleep(RELOAD_WAIT_MS)])
  } catch {
    /* the updater is unavailable or errored: boot normally */
  }
}

/**
 * Report each downloaded-and-queued bundle, including one queued before this screen mounted (the event is
 * not replayed). Resolves to an unsubscribe. Off-device, or if the plugin is absent, reports nothing.
 */
export const watchOtaUpdates: OtaWatch = async (onReady) => {
  if (!Capacitor.isNativePlatform()) return noop
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    const handle = await CapacitorUpdater.addListener('updateAvailable', ({ bundle }) => {
      void armOtaKillDelay() // a bundle was just queued: make sure the delay is in place before any background
      if (bundle?.id && bundle.id !== BUILTIN_BUNDLE_ID) onReady({ version: bundle.version })
    })
    try {
      const [next, current] = await Promise.all([CapacitorUpdater.getNextBundle(), CapacitorUpdater.current()])
      if (next && next.id !== BUILTIN_BUNDLE_ID && next.id !== current.bundle.id) onReady({ version: next.version })
    } catch {
      /* older shell without getNextBundle: the event alone still works */
    }
    return () => {
      void handle.remove().catch(noop)
    }
  } catch {
    return noop
  }
}

/** Apply the queued bundle now. Resolves only if the reload did not happen (the WebView is destroyed on success). */
export async function reloadToApplyOta(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
  await CapacitorUpdater.reload()
}
