import { useState, useEffect, type FormEvent } from 'react'
import { useAuth } from './auth'
import { hideSplash } from './native'
import { SyncProvider } from './cashier/SyncProvider'
import CashierScreen from './cashier/CashierScreen'
import logoGold from './assets/logo-gold.png'

function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await login(email, password)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 320, margin: '4rem auto', fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 28 }}>
        <img src={logoGold} alt="Mandalika" style={{ height: 56, width: 'auto', objectFit: 'contain' }} />
        <p style={{ marginTop: 10, fontSize: 13, fontWeight: 600, color: '#8f6210', letterSpacing: 0.4 }}>
          Point of Sale
        </p>
      </div>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        autoComplete="username"
        type="email"
        style={{ display: 'block', width: '100%', marginBottom: 8, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, boxSizing: 'border-box' }}
      />
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type={showPassword ? 'text' : 'password'}
          placeholder="Password"
          autoComplete="current-password"
          style={{ display: 'block', width: '100%', padding: '8px 44px 8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, boxSizing: 'border-box' }}
        />
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
          style={{ position: 'absolute', top: '50%', right: 6, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}
        >
          {showPassword ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
      <button
        disabled={busy}
        type="submit"
        style={{ width: '100%', padding: '10px 0', background: '#b07d18', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1 }}
      >
        {busy ? 'Masuk…' : 'Masuk'}
      </button>
      {err && <p style={{ color: 'crimson', fontSize: 13, marginTop: 8 }}>{err}</p>}
    </form>
  )
}

export default function App() {
  const { user, ready } = useAuth()
  // The native launch splash has launchAutoHide:false. SyncProvider hides it
  // post-login, but the pre-login screen never mounts SyncProvider — so on a
  // fresh/logged-out app the splash covered the WebView forever (blank app).
  // Hide it as soon as React shows anything; SplashScreen.hide() is idempotent.
  useEffect(() => {
    void hideSplash()
  }, [])
  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui', color: '#6b7280' }}>
        Memuat…
      </div>
    )
  }
  if (!user) return <LoginScreen />
  // Phase C: offline-first CashierScreen wrapped in SyncProvider
  return (
    <SyncProvider>
      <CashierScreen />
    </SyncProvider>
  )
}
