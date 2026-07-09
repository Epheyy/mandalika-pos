// Native shell glue (plan §6: no-refresh app, lifecycle, splash/status bar).
// All calls are guarded so the same build runs unchanged in a browser/dev.

import { Capacitor } from '@capacitor/core'

function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

// Optional in-app back handler. Returns true if it consumed the press (e.g.
// closed a modal); false/absent → the app is minimized (never force-closed).
let backHandler: (() => boolean) | null = null

export function setBackHandler(fn: (() => boolean) | null): void {
  backHandler = fn
}

/**
 * One-time native setup: status-bar style and a hardware back-button guard so
 * Android cannot accidentally close the POS mid-sale (it minimizes instead).
 * Pull-to-refresh / browser chrome don't exist in the Capacitor WebView, so
 * "no accidental refresh" is inherent once we ship the bundled `dist/`.
 */
export async function bootNativeShell(): Promise<void> {
  if (!isNative()) return
  // System bars are managed natively in MainActivity (immersive, edge-to-edge,
  // swipe-to-reveal). Don't drive the StatusBar plugin here or it fights the
  // WindowInsetsController.
  try {
    const { App } = await import('@capacitor/app')
    await App.addListener('backButton', () => {
      // Let the app handle Back first (close a modal/panel). Only if nothing
      // consumed it do we minimize — Android Back must never exit the POS.
      const consumed = backHandler?.() ?? false
      if (!consumed) void App.minimizeApp()
    })
  } catch {
    /* app plugin unavailable — non-fatal */
  }
}

/** Hide the launch splash once the first data load has settled. */
export async function hideSplash(): Promise<void> {
  if (!isNative()) return
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen')
    await SplashScreen.hide()
  } catch {
    /* splash plugin unavailable — non-fatal */
  }
}

/**
 * Confirm to the Capgo updater that this bundle booted OK. If we never call
 * this, the plugin auto-rolls-back to the last good bundle after a timeout.
 * Web/no-op off-device. Dynamically imported so the web build never hard-depends
 * on the native plugin.
 */
export async function otaNotifyReady(): Promise<void> {
  if (!isNative()) return
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    await CapacitorUpdater.notifyAppReady()
  } catch {
    // plugin absent (e.g. older shell) — ignore
  }
}
