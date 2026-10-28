import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { applyBrand, brand } from './brand'
import { AuthProvider } from './auth'
import { PrinterProvider } from './printer'
import { bootNativeShell, hideSplash } from './native'
import { armOtaKillDelay } from './otaUpdate'
import { installGlobalErrorHandler } from './lib/errorReporter'
import App from './App'
import { BootError } from './BootError'
import { bootStorage } from './bootStorage'
import { sweepOrderHistoryCache } from './lib/offlineCache'
import { dropLegacyPinLockout } from './lib/legacyPinLockout'

// Boot order matters: hydrate secure storage (refresh token / outbox / device
// id / snapshot) and set up the native shell BEFORE React reads any of it.
async function boot(): Promise<void> {
  applyBrand(brand)
  // C5: first thing, independent of storage: a queued OTA bundle must not apply on background (re-armed every launch).
  void armOtaKillDelay()
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
