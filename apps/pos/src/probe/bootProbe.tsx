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
