import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initSecureKV } from '@mandalika/sync'
import { AuthProvider } from './auth'
import { PrinterProvider } from './printer'
import { bootNativeShell } from './native'
import App from './App'

// Boot order matters: hydrate secure storage (refresh token / outbox / device
// id / snapshot) and set up the native shell BEFORE React reads any of it.
async function boot(): Promise<void> {
  await initSecureKV()
  await bootNativeShell()

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
