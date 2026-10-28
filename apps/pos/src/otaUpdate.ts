// C5 (D-19): the Capgo glue for the "Versi baru siap" prompt. Kept out of native.ts on purpose: that file
// owns the single OTA-ready confirm (A35), and App-level tests mock it with a fixed export list.
//
// The updater stays in its default `autoUpdate: true` mode (no native/APK change): it downloads in the
// background, emits `updateAvailable` and queues the bundle as "next" (applied when the app goes to the
// background or restarts, exactly as before). This module only OBSERVES that queue and, when the cashier
// taps "Mulai ulang sekarang", calls reload() to apply the already-queued bundle now. Nothing here ever
// applies an update on its own. Everything is a no-op off-device and never throws.

import { Capacitor } from '@capacitor/core'

export interface OtaPending {
  version: string
}

export type OtaWatch = (onReady: (pending: OtaPending) => void) => Promise<() => void>

const BUILTIN_BUNDLE_ID = 'builtin'
const noop = () => {}

/**
 * Report each downloaded-and-queued bundle, including one queued before this screen mounted (the event is
 * not replayed). Resolves to an unsubscribe. Off-device, or if the plugin is absent, reports nothing.
 */
export const watchOtaUpdates: OtaWatch = async (onReady) => {
  if (!Capacitor.isNativePlatform()) return noop
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    const handle = await CapacitorUpdater.addListener('updateAvailable', ({ bundle }) => {
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
