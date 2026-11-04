import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AuthProvider } from './auth'
import { OutletProvider } from './outlet'
import App from './App'
import { applyBrandSkin } from './lib/brand'
import { installChunkReloadGuard } from './lib/chunkReload'
import { ConfirmProvider } from './ui/ConfirmDialog'
import { ToastProvider } from './ui/Toast'

applyBrandSkin()
installChunkReloadGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <OutletProvider>
        <ToastProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </ToastProvider>
      </OutletProvider>
    </AuthProvider>
  </StrictMode>,
)
