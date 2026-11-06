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
// change. Blur budget (plan 5.1): 0 blurred layers by default, never more than 2, never inside a scroller.
const MATERIAL: 'glass' | 'static' | 'solid' = 'static'
const BLUR_BUDGET = 0
// The ambient ground is mounted but hidden until a later slice turns it on ('on').
const AMBIENT: 'on' | 'off' = 'off'

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
