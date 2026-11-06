import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import './probe.css'
import { ProbeScreen } from './ProbeScreen'

const root = document.documentElement
root.dataset.material = 'glass'
root.dataset.ambient = 'on'
root.dataset.brand = 'mandalika'
const layer = document.createElement('div')
layer.className = 'ambient-layer'
layer.setAttribute('aria-hidden', 'true')
document.body.prepend(layer)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProbeScreen />
  </StrictMode>,
)

// The app config keeps the native splash up (launchAutoHide: false) until the app hides it, as the real
// boot does once it is ready. The probe has no other boot step, so hide it right after the first render.
requestAnimationFrame(() => {
  import('@capacitor/splash-screen')
    .then(({ SplashScreen }) => SplashScreen.hide())
    .catch(() => undefined) // web/dev: no native splash
})
