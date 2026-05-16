import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AuthProvider } from './auth'
import { OutletProvider } from './outlet'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <OutletProvider>
        <App />
      </OutletProvider>
    </AuthProvider>
  </StrictMode>,
)
