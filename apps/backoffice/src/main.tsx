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
// 'glass' = real blur on the top bar (owner D-86: <main> scrolls under it), 'static' = the same tint without blur,
// 'solid' = opaque. Falling back is a one-line change (set 'static'). Blur budget (plan 5.1): the top bar is the
// one blurred layer, never inside a scroller, sheet, drawer, toast or dialog.
const MATERIAL: 'glass' | 'static' | 'solid' = 'glass'
const BLUR_BUDGET = 1
// The ambient ground (D-87): Mandalika gold/peach, other brands a neutral paper wash. 'off' hides it.
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
