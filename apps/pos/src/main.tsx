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
import { sweepOrderHistoryCache } from './lib/offlineCache'
import { dropLegacyPinLockout } from './lib/legacyPinLockout'

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
async function boot(): Promise<void> {
  applyBrand(brand)
  applyMaterial(brand.id)
  // C5: first thing, before storage hydrate and any UI/cart: arm the kill delay (a queued OTA bundle must not
  // apply on background) and apply a bundle queued by an earlier session once. Bounded, never throws.
  await startupOta()
  try {
    await bootStorage()
  } catch (err) {
    // Never fall back to an empty queue: stop with a visible, retryable error.
    void hideSplash()
    createRoot(document.getElementById('root')!).render(
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

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <PrinterProvider>
          <App />
        </PrinterProvider>
      </AuthProvider>
    </StrictMode>,
  )
}

void boot()
