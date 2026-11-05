import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AuthProvider } from './auth'
import { OutletProvider } from './outlet'
import App from './App'
import { applyBrandSkin, BRAND } from './lib/brand'
import { installChunkReloadGuard } from './lib/chunkReload'
import { ConfirmProvider } from './ui/ConfirmDialog'
import { ToastProvider } from './ui/Toast'

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

applyBrandSkin()
applyMaterial(BRAND.id)
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
