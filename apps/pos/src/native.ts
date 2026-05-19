// Native shell glue (plan §6: no-refresh app, lifecycle, splash/status bar).
// All calls are guarded so the same build runs unchanged in a browser/dev.

import { Capacitor } from '@capacitor/core'

export function isNative(): boolean {
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
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    // Don't draw the WebView under the status bar — avoids the content /
    // status-bar overlap. Tinted to the brand colour with light icons.
    await StatusBar.setOverlaysWebView({ overlay: false })
    await StatusBar.setStyle({ style: Style.Light })
    await StatusBar.setBackgroundColor({ color: '#4f46e5' })
  } catch {
    /* status-bar plugin unavailable — non-fatal */
  }
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
