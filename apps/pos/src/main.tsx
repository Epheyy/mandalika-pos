import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { applyBrand, brand } from './brand'
import { AuthProvider } from './auth'
import { PrinterProvider } from './printer'
import { bootNativeShell, hideSplash } from './native'
import { startupOta } from './otaUpdate'
import { installGlobalErrorHandler } from './lib/errorReporter'
import App from './App'
import { BootError } from './BootError'
import { bootStorage } from './bootStorage'
import { claimActiveTab } from './tabGuard'
import { TabBlocked } from './TabBlocked'
import { TabGuardUnavailableNotice } from './TabGuardUnavailableNotice'
import { sweepOrderHistoryCache } from './lib/offlineCache'
import { dropLegacyPinLockout } from './lib/legacyPinLockout'
import { installKeyboardInset } from './keyboardInset'

// Kaca materials (packages/ui-tokens/materials.css). One constant picks the chrome material for the whole app:
// 'static' = glass tint without blur (default), 'glass' = real blur, 'solid' = opaque. Falling back is a one-line
// change. P6a: 'glass' (A9 probe passed 2026-11-06, about +2 ms/frame, 0 frames over 50 ms). Blur budget (plan 5.1):
// exactly ONE blurred layer on the POS, the combined header + category band in ProductGrid (`data-kaca-band`); never
// in a scroller, sheet, drawer, toast or dialog. To fall back to the tint without blur, set MATERIAL to 'static'.
const MATERIAL: 'glass' | 'static' | 'solid' = 'glass'
const BLUR_BUDGET = 1
// The ambient ground (D-87: gold/peach on Mandalika, neutral paper on the other brands, via data-brand CSS).
const AMBIENT: 'on' | 'off' = 'on'

function applyMaterial(brandId: string, root: HTMLElement = document.documentElement): void {
  root.dataset.material = MATERIAL
  root.dataset.blurBudget = String(BLUR_BUDGET)
  root.dataset.ambient = AMBIENT
  root.dataset.brand = brandId
  if (!document.querySelector('.ambient-layer')) {
    const layer = document.createElement('div')
    layer.className = 'ambient-layer'
    layer.setAttribute('aria-hidden', 'true')
    document.body.prepend(layer)
  }
}

// Boot order matters: hydrate secure storage (refresh token / outbox / device
// id / snapshot) and set up the native shell BEFORE React reads any of it.
// A refresh/reload hands the lock over within a moment; only a longer wait shows the "other tab" screen.
const TAB_BLOCKED_SHOW_MS = 800

async function boot(): Promise<void> {
  applyBrand(brand)
  applyMaterial(brand.id)
  // Sheets end above the Android soft keyboard (DOM only, so it can run before the first render).
  installKeyboardInset()
  const root = createRoot(document.getElementById('root')!)
  // F22/W01: ONE live tab per browser profile, claimed before anything touches storage (OTA, journal, sync engine,
  // cart draft). A second tab waits here, shows a notice, and continues by itself when the first one closes.
  const claim = await claimActiveTab()
  if (!claim.owner) {
    const notice = setTimeout(() => root.render(<TabBlocked />), TAB_BLOCKED_SHOW_MS)
    await claim.granted
    clearTimeout(notice)
  }
  // A page restored from the back/forward cache would run on state (and a lock) from before it was frozen.
  window.addEventListener('pageshow', (e) => { if (e.persisted) window.location.reload() })
  // C5: first thing, before storage hydrate and any UI/cart: arm the kill delay (a queued OTA bundle must not
  // apply on background) and apply a bundle queued by an earlier session once. Bounded, never throws.
  await startupOta()
  try {
    await bootStorage()
  } catch (err) {
    // Never fall back to an empty queue: stop with a visible, retryable error.
    void hideSplash()
    root.render(
      <BootError detail={err instanceof Error ? err.message : 'storage init failed'} />,
    )
    return
  }
  await bootNativeShell()
  installGlobalErrorHandler()
  // A30: drop history-cache keys older builds wrote per typed search term, and bound the rest.
  sweepOrderHistoryCache()
  // A08: the receive-PIN lockout is server-side now; drop the old local copy.
  dropLegacyPinLockout()

  root.render(
    <StrictMode>
      {claim.owner && claim.unguarded ? <TabGuardUnavailableNotice /> : null}
      <AuthProvider>
        <PrinterProvider>
          <App />
        </PrinterProvider>
      </AuthProvider>
    </StrictMode>,
  )
}

void boot()
